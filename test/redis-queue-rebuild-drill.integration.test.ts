import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createProcessingApplication } from "../src/api/application.js";
import type { CallerIdentityResolver } from "../src/api/identity.js";
import { createFileControlledAsyncIntake } from "../src/app/async-intake.js";
import { createAsyncProcessRuns } from "../src/process-runs/index.js";
import { createOutboxDispatcher } from "../src/process-runs/outbox/dispatcher.js";
import { createPostgresProcessOutbox } from "../src/process-runs/outbox/postgres.js";
import {
    createBullMqProcessWorker,
    createBullMqProcessWorkQueue,
    defaultProcessWorkQueueName,
    defaultProcessWorkQueuePrefix,
} from "../src/process-runs/queue/bullmq.js";
import type { ProcessWorkJob } from "../src/process-runs/queue/index.js";
import { runQueueRecoveryCommand } from "../src/process-runs/recovery/command.js";
import {
    createProcessRunReconciler,
    type ProcessRecoveryReport,
} from "../src/process-runs/recovery/index.js";
import { createPostgresProcessRunRecoverySource } from "../src/process-runs/recovery/postgres.js";
import { createPostgresProcessRunStore } from "../src/process-runs/store/postgres.js";
import type { ProcessWorker } from "../src/process-runs/worker/index.js";
import { createProcessWorker } from "../src/process-runs/worker/index.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    defineProcessRegistration,
} from "../src/process-runtime/index.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_TEST_URL;
if (process.env.RUN_ASYNC_INTEGRATION === "1" && (!databaseUrl || !redisUrl)) {
    throw new Error(
        "POSTGRES_TEST_DATABASE_URL and REDIS_TEST_URL are required for the Redis rebuild drill",
    );
}

const integrationDescribe =
    databaseUrl && redisUrl ? describe.sequential : describe.skip;

integrationDescribe("Redis loss and Queue rebuild drill", () => {
    let pool: Pool;
    let redis: Redis;

    beforeAll(async () => {
        assertTestDatabase(databaseUrl as string);
        assertTestRedis(redisUrl as string);
        pool = new Pool({ connectionString: databaseUrl, max: 6 });
        redis = new Redis(redisUrl as string, { maxRetriesPerRequest: 1 });
        redis.on("error", () => {});
        await pool.query("DROP SCHEMA public CASCADE");
        await pool.query("CREATE SCHEMA public");
        await migrate(databaseUrl as string);
        await redis.flushdb();
    }, 30_000);

    afterAll(async () => {
        redis?.disconnect();
        await pool?.end();
    });

    it("durably accepts without Redis and rebuilds only PostgreSQL nonterminal work", async () => {
        const startedAt = new Date().toISOString();
        const registry = drillRegistry();
        const store = createPostgresProcessRunStore({
            pool,
            retention: RETENTION,
            claimLeaseMs: 1_500,
        });
        const runs = createAsyncProcessRuns({ registry, store });
        const outbox = createPostgresProcessOutbox({ pool });
        let currentRedisUrl = redisUrl as string;
        let queue = createBullMqProcessWorkQueue({
            redisUrl: currentRedisUrl,
            onError: () => {},
        });
        let inspector = new Queue<ProcessWorkJob>(defaultProcessWorkQueueName, {
            connection: { url: currentRedisUrl },
            prefix: defaultProcessWorkQueuePrefix,
        });
        inspector.on("error", () => {});
        const workers: ReturnType<typeof createBullMqProcessWorker>[] = [];
        let intakeDirectory: string | undefined;
        let closeApi: (() => Promise<void>) | undefined;
        let redisStopped = false;

        try {
            await queue.ready();
            intakeDirectory = await mkdtemp(
                path.join(tmpdir(), "pipipi-redis-rebuild-intake-"),
            );
            const intakeMarker = path.join(intakeDirectory, "intake-disabled");
            const intake = createFileControlledAsyncIntake({
                disabledMarkerFile: intakeMarker,
            });
            const api = createProcessingApplication({
                executor: unusedExecutor,
                http: {
                    logSink: () => {},
                    asyncProcessRuns: {
                        runs,
                        callerIdentity: drillCallerIdentity,
                        readiness: async () => {},
                        intakeOpen: intake.isOpen,
                    },
                },
            });
            closeApi = api.close;
            const { url: apiUrl } = await api.listen();
            await Promise.all([queue.close(), inspector.close()]);
            await controlRedis("stop");
            redisStopped = true;
            const acceptedResponse = await fetch(`${apiUrl}/process-runs`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": "redis-drill-redis-down",
                    "x-test-caller": CALLER_ID,
                },
                body: JSON.stringify({
                    process: "redis-rebuild-drill",
                    version: "v1",
                    input: { value: "redis-down" },
                }),
            });
            expect(acceptedResponse.status).toBe(202);
            const accepted = (await acceptedResponse.json()) as {
                runId: string;
                status: string;
            };
            expect(accepted.status).toBe("queued");
            const redisDown = { runId: accepted.runId };
            await expect(ownerGet(apiUrl, redisDown.runId)).resolves.toEqual({
                httpStatus: 200,
                runStatus: "queued",
            });
            const unavailableQueue = createBullMqProcessWorkQueue({
                redisUrl: currentRedisUrl,
                connectTimeoutMs: 250,
                onError: () => {},
            });
            try {
                await expect(
                    createOutboxDispatcher({
                        outbox,
                        queue: unavailableQueue,
                    }).dispatchOnce(),
                ).resolves.toEqual({ claimed: 1, published: 0, failed: 1 });
            } finally {
                await unavailableQueue.close();
            }
            expect(await pendingOutboxCount(pool)).toBe(1);
            await expect(ownerGet(apiUrl, redisDown.runId)).resolves.toEqual({
                httpStatus: 200,
                runStatus: "queued",
            });
            await controlRedis("start");
            redisStopped = false;
            currentRedisUrl = await projectRedisUrl();
            redis.disconnect();
            redis = new Redis(currentRedisUrl, { maxRetriesPerRequest: 1 });
            redis.on("error", () => {});
            await waitForRedis(redis);
            queue = createBullMqProcessWorkQueue({
                redisUrl: currentRedisUrl,
                onError: () => {},
            });
            inspector = new Queue<ProcessWorkJob>(defaultProcessWorkQueueName, {
                connection: { url: currentRedisUrl },
                prefix: defaultProcessWorkQueuePrefix,
            });
            inspector.on("error", () => {});
            await queue.ready();

            await expect(
                createOutboxDispatcher({ outbox, queue }).dispatchOnce(),
            ).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
            const relayWorker = runtimeWorker(registry, store, currentRedisUrl);
            workers.push(relayWorker);
            await relayWorker.start();
            await waitForTerminal(runs, redisDown.runId);
            await relayWorker.close();

            const invalid = await submit(runs, "invalid");
            const expired = await submit(runs, "expired");
            const terminalJob = await submit(runs, "terminal-job");
            const active = await submit(runs, "active");
            const pending = await submit(runs, "pending-outbox");
            await expect(
                createOutboxDispatcher({
                    outbox,
                    queue,
                    batchSize: 4,
                }).dispatchOnce(),
            ).resolves.toEqual({ claimed: 4, published: 4, failed: 0 });

            await redis.flushdb();
            await inspector.add(
                "process-run",
                {
                    schemaVersion: 1,
                    runId: invalid.runId,
                    extra: true,
                } as unknown as ProcessWorkJob,
                { jobId: invalid.runId },
            );
            await inspector.add(
                "process-run",
                { schemaVersion: 1, runId: terminalJob.runId },
                { jobId: terminalJob.runId },
            );
            const ignored = createBullMqProcessWorker({
                redisUrl: currentRedisUrl,
                worker: ignoredWorker,
                onError: () => {},
            });
            workers.push(ignored);
            await ignored.start();
            await waitForJobState(inspector, terminalJob.runId, "completed");
            await ignored.close();
            await store.claim({
                runId: expired.runId,
                claimToken: "10000000-0000-4000-8000-000000000001",
                claimedAt: new Date().toISOString(),
            });
            await delay(1_550);
            const activeClaimedAt = Date.now();
            await store.claim({
                runId: active.runId,
                claimToken: "10000000-0000-4000-8000-000000000002",
                claimedAt: new Date(activeClaimedAt).toISOString(),
            });

            await writeFile(intakeMarker, "");
            expect(intake.isOpen()).toBe(false);
            const runCountBeforeRejectedPost =
                await authoritativeRunCount(pool);
            const outboxCountBeforeRejectedPost = await totalOutboxCount(pool);
            const rejected = await fetch(`${apiUrl}/process-runs`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": "must-not-be-accepted",
                    "x-test-caller": CALLER_ID,
                },
                body: JSON.stringify({
                    process: "redis-rebuild-drill",
                    version: "v1",
                    input: { value: "rejected-during-recovery" },
                }),
            });
            expect(rejected.status).toBe(503);
            const rejectedBody = (await rejected.json()) as {
                error?: { code?: string };
            };
            expect(rejectedBody.error?.code).toBe("ASYNC_INTAKE_CLOSED");
            expect(await authoritativeRunCount(pool)).toBe(
                runCountBeforeRejectedPost,
            );
            expect(await totalOutboxCount(pool)).toBe(
                outboxCountBeforeRejectedPost,
            );
            await expect(ownerGet(apiUrl, active.runId)).resolves.toEqual({
                httpStatus: 200,
                runStatus: "running",
            });

            const recovery = createProcessRunReconciler({
                store: createPostgresProcessRunRecoverySource({ pool }),
                queue,
                batchSize: 2,
            });
            const cutoff = new Date().toISOString();
            const dryRun = await fullRecovery(recovery, true, cutoff);
            const dryTotals = totals(dryRun);
            assertCompleteDryRun(dryRun);
            expect(dryTotals).toMatchObject({
                found: 5,
                missingJobs: 3,
                terminalJobs: 1,
                invalidJobs: 1,
                activeLeases: 1,
                pendingOutbox: 1,
                failed: 0,
            });
            expect(
                dryRun
                    .flatMap((report) => report.items)
                    .find((item) => item.runId === active.runId),
            ).toMatchObject({ action: "deferred", reason: "active_lease" });

            const apply = await fullRecovery(recovery, false, cutoff);
            expect(apply.at(-1)?.nextCursor).toBeUndefined();
            expect(totals(apply)).toMatchObject({
                found: 5,
                enqueued: 4,
                outboxAcknowledged: 1,
                failed: 0,
            });
            expect(await pendingOutboxCount(pool)).toBe(0);

            const worker = runtimeWorker(registry, store, currentRedisUrl);
            workers.push(worker);
            await worker.start();
            await Promise.all(
                [invalid, expired, terminalJob, pending].map((run) =>
                    waitForTerminal(runs, run.runId),
                ),
            );
            await delay(Math.max(0, 1_550 - (Date.now() - activeClaimedAt)));
            const activeCutoff = new Date().toISOString();
            const activeDryRun = await fullRecovery(
                recovery,
                true,
                activeCutoff,
            );
            assertCompleteDryRun(activeDryRun);
            expect(totals(activeDryRun)).toMatchObject({
                found: 1,
                missingJobs: 1,
                activeLeases: 0,
                failed: 0,
            });
            const activeApply = await fullRecovery(
                recovery,
                false,
                activeCutoff,
            );
            expect(totals(activeApply)).toMatchObject({
                found: 1,
                enqueued: 1,
                failed: 0,
            });
            await waitForTerminal(runs, active.runId);

            const orphanRunId = "00000000-0000-4000-8000-000000000777";
            await expect(
                queue.enqueue({ schemaVersion: 1, runId: orphanRunId }),
            ).resolves.toBe("enqueued");
            await waitForJobState(inspector, orphanRunId, "completed");
            expect(
                await pool.query(
                    "SELECT 1 FROM process_runs WHERE run_id = $1",
                    [orphanRunId],
                ),
            ).toMatchObject({ rowCount: 0 });
            await worker.close();

            const verification = await fullRecovery(
                recovery,
                true,
                new Date().toISOString(),
            );
            expect(totals(verification)).toMatchObject({
                missingJobs: 0,
                invalidJobs: 0,
                failed: 0,
            });
            expect(
                await pool.query(
                    "SELECT 1 FROM queue_recovery_items WHERE run_id = $1",
                    [redisDown.runId],
                ),
            ).toMatchObject({ rowCount: 0 });
            expect(await authoritativeRunCount(pool)).toBe(6);

            await writeEvidence({
                schemaVersion: 1,
                event: "async_redis_queue_rebuild_drill_completed",
                environment: "isolated-staging",
                revision: drillRevision(),
                actor: ACTOR_ID,
                startedAt,
                completedAt: new Date().toISOString(),
                productionTrafficAffected: false,
                intakeClosedDuringRecovery: true,
                ownerReadsPreserved: true,
                intakeClosure: {
                    rejectedStatus: rejected.status,
                    errorCode: rejectedBody.error?.code,
                    runCountUnchanged: true,
                    outboxCountUnchanged: true,
                },
                redisUnavailableAcceptance: {
                    runId: redisDown.runId,
                    acceptedStatus: "queued",
                    pendingOutboxObserved: true,
                    relayedToTerminal: true,
                },
                runIds: {
                    authoritativeTerminal: redisDown.runId,
                    invalidQueueJob: invalid.runId,
                    expiredLease: expired.runId,
                    terminalQueueJob: terminalJob.runId,
                    activeLease: active.runId,
                    pendingOutbox: pending.runId,
                    orphanQueueJob: orphanRunId,
                },
                dryRun: evidenceReports(dryRun),
                apply: evidenceReports(apply),
                activeLeaseDryRun: evidenceReports(activeDryRun),
                activeLeaseApply: evidenceReports(activeApply),
                verification: evidenceReports(verification),
                totals: {
                    dryRun: dryTotals,
                    apply: totals(apply),
                    activeLeaseDryRun: totals(activeDryRun),
                    activeLeaseApply: totals(activeApply),
                    verification: totals(verification),
                },
                terminalRunExcludedFromRecovery: true,
                orphanQueueJobIgnored: true,
                queueDidNotCreateAuthoritativeRun: true,
                authoritativeRunCount: 6,
            });
        } finally {
            if (redisStopped) {
                await controlRedis("start").catch(() => {});
            }
            await Promise.allSettled([
                ...workers.map((worker) => worker.close()),
                queue.close(),
                inspector.close(),
                ...(closeApi ? [closeApi()] : []),
                ...(intakeDirectory
                    ? [rm(intakeDirectory, { recursive: true, force: true })]
                    : []),
            ]);
        }
    }, 45_000);
});

function drillRegistry() {
    return createProcessRegistry([
        defineProcessRegistration({
            id: "redis-rebuild-drill",
            version: "v1",
            inputSchema: z.strictObject({ value: z.string() }),
            outputSchema: z.strictObject({ value: z.string() }),
            execute: async (input) => ({ value: `completed:${input.value}` }),
        }),
    ]);
}

function runtimeWorker(
    registry: ReturnType<typeof drillRegistry>,
    store: ReturnType<typeof createPostgresProcessRunStore>,
    workerRedisUrl: string,
) {
    return createBullMqProcessWorker({
        redisUrl: workerRedisUrl,
        worker: createProcessWorker({
            registry,
            store,
            attemptRunner: createProcessAttemptRunner({
                processTimeoutMs: 5_000,
            }),
        }),
        onError: () => {},
    });
}

async function submit(
    runs: ReturnType<typeof createAsyncProcessRuns>,
    value: string,
) {
    const submitted = await runs.submit(
        {
            process: "redis-rebuild-drill",
            version: "v1",
            input: { value },
        },
        { callerId: CALLER_ID, idempotencyKey: `redis-drill-${value}` },
    );
    if (!submitted.accepted) throw new Error("Expected accepted drill Run");
    return submitted;
}

async function fullRecovery(
    reconciler: ReturnType<typeof createProcessRunReconciler>,
    dryRun: boolean,
    asOf: string,
) {
    return runQueueRecoveryCommand({
        reconciler,
        command: {
            dryRun,
            mode: "all",
            actorId: ACTOR_ID,
            asOf,
            singleBatch: false,
        },
    });
}

function assertCompleteDryRun(reports: readonly ProcessRecoveryReport[]) {
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.at(-1)?.nextCursor).toBeUndefined();
    expect(totals(reports).failed).toBe(0);
}

function totals(reports: readonly ProcessRecoveryReport[]) {
    const keys = [
        "found",
        "missingJobs",
        "existingJobs",
        "terminalJobs",
        "invalidJobs",
        "activeLeases",
        "pendingOutbox",
        "enqueued",
        "duplicates",
        "outboxAcknowledged",
        "failed",
    ] as const;
    return Object.fromEntries(
        keys.map((key) => [
            key,
            reports.reduce((sum, report) => sum + report[key], 0),
        ]),
    );
}

function evidenceReports(reports: readonly ProcessRecoveryReport[]) {
    return reports.map((report) => ({
        recoveryId: report.recoveryId,
        dryRun: report.dryRun,
        actor: report.actorId,
        asOf: report.asOf,
        found: report.found,
        missing: report.missingJobs,
        existing: report.existingJobs,
        terminal: report.terminalJobs,
        invalid: report.invalidJobs,
        deferred: report.activeLeases,
        pendingOutbox: report.pendingOutbox,
        enqueued: report.enqueued,
        failed: report.failed,
        nextCursor: report.nextCursor ?? null,
        items: report.items.map((item) => ({
            runId: item.runId,
            reason: item.reason,
            queueState: item.queueState,
            action: item.action,
            outboxAction: item.outboxAction,
        })),
    }));
}

async function waitForTerminal(
    runs: ReturnType<typeof createAsyncProcessRuns>,
    runId: string,
) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const run = await runs.find(runId, { callerId: CALLER_ID });
        if (run?.status === "succeeded" || run?.status === "failed") return run;
        await delay(20);
    }
    throw new Error(`Redis rebuild Run ${runId} did not reach terminal`);
}

async function waitForJobState(
    queue: Queue<ProcessWorkJob>,
    runId: string,
    expected: string,
) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const job = await queue.getJob(runId);
        if (job && (await job.getState()) === expected) return;
        await delay(20);
    }
    throw new Error(`Queue Job ${runId} did not reach ${expected}`);
}

async function pendingOutboxCount(pool: Pool) {
    const result = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM outbox_messages WHERE topic = 'process-runs' AND published_at IS NULL",
    );
    return result.rows[0]?.count ?? 0;
}

async function authoritativeRunCount(pool: Pool) {
    const result = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM process_runs",
    );
    return result.rows[0]?.count ?? 0;
}

async function totalOutboxCount(pool: Pool) {
    const result = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM outbox_messages WHERE topic = 'process-runs'",
    );
    return result.rows[0]?.count ?? 0;
}

const ignoredWorker: ProcessWorker = {
    process: async () => "ignored",
    releaseActive: async () => 0,
};

const drillCallerIdentity: CallerIdentityResolver = {
    resolve: async (headers) => {
        const callerId = headers["x-test-caller"];
        return typeof callerId === "string" ? { callerId } : undefined;
    },
};

const unusedExecutor = {
    execute: async () => ({
        runId: "00000000-0000-4000-8000-000000000099",
        process: "unused",
        version: "v1",
        status: "succeeded" as const,
        output: {},
    }),
};

async function ownerGet(apiUrl: string, runId: string) {
    const response = await fetch(`${apiUrl}/process-runs/${runId}`, {
        headers: { "x-test-caller": CALLER_ID },
    });
    const body = (await response.json()) as { status?: string };
    return { httpStatus: response.status, runStatus: body.status };
}

const execFileAsync = promisify(execFile);

async function controlRedis(operation: "start" | "stop") {
    const projectName = process.env.ASYNC_INTEGRATION_PROJECT_NAME;
    if (!projectName) {
        throw new Error(
            "ASYNC_INTEGRATION_PROJECT_NAME is required to control drill Redis",
        );
    }
    const action =
        operation === "start"
            ? ["up", "--detach", "--wait", "redis"]
            : ["stop", "redis"];
    await execFileAsync(
        "docker",
        [
            "compose",
            "--project-name",
            projectName,
            "--file",
            "compose.integration.yaml",
            ...action,
        ],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                PIPIPI_POSTGRES_PORT: "0",
                PIPIPI_REDIS_PORT: "0",
            },
        },
    );
}

async function projectRedisUrl() {
    const projectName = process.env.ASYNC_INTEGRATION_PROJECT_NAME;
    if (!projectName) {
        throw new Error(
            "ASYNC_INTEGRATION_PROJECT_NAME is required to discover drill Redis",
        );
    }
    const { stdout } = await execFileAsync(
        "docker",
        [
            "compose",
            "--project-name",
            projectName,
            "--file",
            "compose.integration.yaml",
            "port",
            "redis",
            "6379",
        ],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                PIPIPI_POSTGRES_PORT: "0",
                PIPIPI_REDIS_PORT: "0",
            },
        },
    );
    const match = /:(\d+)\s*$/.exec(stdout);
    const port = Number(match?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("Docker Compose did not return restored Redis port");
    }
    return `redis://127.0.0.1:${port}/15`;
}

async function waitForRedis(client: Redis) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try {
            if ((await client.ping()) === "PONG") return;
        } catch {
            await delay(50);
        }
    }
    throw new Error("Redis did not recover after the rebuild drill outage");
}

async function writeEvidence(evidence: unknown) {
    const target = process.env.ASYNC_REDIS_REBUILD_DRILL_EVIDENCE_FILE;
    if (!target) return;
    const file = path.resolve(target);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, {
        mode: 0o600,
    });
}

function drillRevision() {
    const revision =
        process.env.ASYNC_REDIS_REBUILD_DRILL_REVISION ?? "f".repeat(40);
    if (!/^[0-9a-f]{40}$/.test(revision))
        throw new Error("Redis rebuild drill revision must be a full SHA");
    return revision;
}

function delay(milliseconds: number) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function migrate(url: string) {
    return runner({
        databaseUrl: url,
        direction: "up",
        dir: path.resolve("migrations"),
        migrationsTable: "pgmigrations",
        count: Infinity,
        advisoryLockMode: "wait",
        log: () => {},
    });
}

function assertTestDatabase(url: string) {
    if (!new URL(url).pathname.slice(1).endsWith("_test"))
        throw new Error("Redis rebuild drill requires a *_test database");
}

function assertTestRedis(value: string) {
    const url = new URL(value);
    const database = Number(url.pathname.slice(1));
    if (
        url.protocol !== "redis:" ||
        (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
        !Number.isInteger(database) ||
        database < 1
    ) {
        throw new Error(
            "Redis rebuild drill requires local Redis with a non-zero database",
        );
    }
}

const CALLER_ID = "operator:redis-rebuild-drill";
const ACTOR_ID = "operator:redis-rebuild-drill";
const RETENTION = {
    acceptedInputMs: 86_400_000,
    resultMs: 604_800_000,
    metadataMs: 2_592_000_000,
} as const;
