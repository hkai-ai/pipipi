import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createProcessDispatcherRuntime } from "../src/process-runs/dispatcher.js";
import {
    createAsyncProcessRuns,
    type ProcessRunView,
} from "../src/process-runs/index.js";
import { createOutboxDispatcher } from "../src/process-runs/outbox/dispatcher.js";
import { createPostgresProcessOutbox } from "../src/process-runs/outbox/postgres.js";
import {
    createBullMqProcessWorker,
    createBullMqProcessWorkQueue,
    defaultProcessWorkQueueName,
    defaultProcessWorkQueuePrefix,
} from "../src/process-runs/queue/bullmq.js";
import type { ProcessWorkJob } from "../src/process-runs/queue/index.js";
import { createProcessRunReconciler } from "../src/process-runs/recovery/index.js";
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
        "POSTGRES_TEST_DATABASE_URL and REDIS_TEST_URL are required for the Dispatcher/Worker drill",
    );
}

const integrationDescribe =
    databaseUrl && redisUrl ? describe.sequential : describe.skip;

integrationDescribe("Dispatcher and Worker fault drill", () => {
    let pool: Pool;
    let redis: Redis;

    beforeAll(async () => {
        assertTestDatabase(databaseUrl as string);
        assertTestRedis(redisUrl as string);
        pool = new Pool({ connectionString: databaseUrl, max: 6 });
        redis = new Redis(redisUrl as string, { maxRetriesPerRequest: 1 });
        await pool.query("DROP SCHEMA public CASCADE");
        await pool.query("CREATE SCHEMA public");
        await migrate(databaseUrl as string);
        await redis.flushdb();
    }, 30_000);

    afterAll(async () => {
        await Promise.all([pool?.end(), redis?.quit()]);
    });

    it("preserves one authoritative terminal through dispatcher restart, stale claims, duplicates, and rolling shutdown", async () => {
        const startedAt = new Date().toISOString();
        const control = createDrillControl();
        const registry = createDrillRegistry(control);
        const store = createPostgresProcessRunStore({
            pool,
            retention: RETENTION,
            claimLeaseMs: 150,
        });
        const runs = createAsyncProcessRuns({ registry, store });
        const outbox = createPostgresProcessOutbox({ pool });
        const queue = createBullMqProcessWorkQueue({
            redisUrl: redisUrl as string,
        });
        const inspector = new Queue<ProcessWorkJob>(
            defaultProcessWorkQueueName,
            {
                connection: { url: redisUrl as string },
                prefix: defaultProcessWorkQueuePrefix,
            },
        );
        const workers: ReturnType<typeof createBullMqProcessWorker>[] = [];

        try {
            await queue.ready();
            const dispatcher = await dispatcherRestartScenario({
                pool,
                runs,
                outbox,
                queue,
                registry,
                store,
                control,
                workers,
            });
            const fencing = await fencingScenario({
                pool,
                runs,
                outbox,
                queue,
                inspector,
                registry,
                store,
                control,
                workers,
            });
            const rolling = await rollingUpgradeScenario({
                pool,
                runs,
                outbox,
                queue,
                inspector,
                registry,
                store,
                control,
                workers,
            });
            const evidence = Object.freeze({
                schemaVersion: 1 as const,
                event: "async_dispatcher_worker_fault_drill_completed",
                environment: "isolated-staging" as const,
                revision: drillRevision(),
                startedAt,
                completedAt: new Date().toISOString(),
                productionTrafficAffected: false as const,
                scenarios: [dispatcher, fencing, rolling] as const,
            });

            expect(evidence.scenarios).toHaveLength(3);
            expect(
                evidence.scenarios.every(
                    (scenario) =>
                        scenario.terminalStatus === "succeeded" &&
                        scenario.authoritativeRunCount === 1 &&
                        scenario.terminalEventCount === 1 &&
                        scenario.idempotentEffectCount === 1,
                ),
            ).toBe(true);
            expect(rolling.observations.capabilityInvocationCount).toBe(2);
            expect(rolling.observations.capabilityEffectAttemptCount).toBe(2);
            expect(JSON.stringify(evidence)).not.toMatch(
                /claimToken|idempotency|input|output|secret|url|redis|database/i,
            );
            await writeEvidence(evidence);
        } finally {
            await Promise.allSettled([
                ...workers.map((worker) => worker.close()),
                queue.close(),
                inspector.close(),
            ]);
        }
    }, 30_000);
});

type DrillContext = Readonly<{
    pool: Pool;
    runs: ReturnType<typeof createAsyncProcessRuns>;
    outbox: ReturnType<typeof createPostgresProcessOutbox>;
    queue: ReturnType<typeof createBullMqProcessWorkQueue>;
    registry: ReturnType<typeof createDrillRegistry>;
    store: ReturnType<typeof createPostgresProcessRunStore>;
    control: DrillControl;
    workers: ReturnType<typeof createBullMqProcessWorker>[];
}>;

type DrillScenario = Readonly<{
    name:
        | "dispatcher_publish_before_ack"
        | "stale_claim_and_duplicate_job"
        | "ready_first_rolling_shutdown";
    runId: string;
    terminalStatus: "succeeded";
    authoritativeRunCount: 1;
    terminalEventCount: 1;
    idempotentEffectCount: 1;
    attempts: readonly Readonly<{
        number: number;
        status: string;
        resultCode: string;
    }>[];
    timeline: Readonly<Record<string, string>>;
    observations: Readonly<Record<string, boolean | number | string>>;
}>;

async function dispatcherRestartScenario(
    context: DrillContext,
): Promise<DrillScenario> {
    const acceptedAt = new Date().toISOString();
    const submitted = await submit(context.runs, "dispatcher");
    const firstPublished = deferred<void>();
    const firstFault = deferred<void>();
    let firstClaimedAt = "";
    const interruptedRelay = createOutboxDispatcher({
        outbox: {
            claimProcessWork: async (request) => {
                firstClaimedAt = request.claimedAt;
                return context.outbox.claimProcessWork(request);
            },
            markPublished: async () => {
                firstPublished.resolve();
                throw new Error(
                    "Injected Dispatcher failure before Outbox acknowledgement",
                );
            },
            release: async () => {
                throw new Error("Injected Dispatcher process termination");
            },
        },
        queue: context.queue,
        claimLeaseMs: 50,
    });
    const firstRuntime = dispatcherRuntime(context, interruptedRelay, () =>
        firstFault.resolve(),
    );
    await firstRuntime.ready();
    await firstRuntime.start();
    await firstPublished.promise;
    const firstPublishedAt = new Date().toISOString();
    await firstFault.promise;
    await firstRuntime.close();
    const firstDispatcherStoppedAt = new Date().toISOString();

    await delay(70);
    const replayed =
        deferred<
            Readonly<{ claimed: number; published: number; failed: number }>
        >();
    const relay = createOutboxDispatcher({
        outbox: context.outbox,
        queue: context.queue,
        claimLeaseMs: 50,
    });
    const restartedRuntime = dispatcherRuntime(context, {
        dispatchOnce: async () => {
            const result = await relay.dispatchOnce();
            replayed.resolve(result);
            return result;
        },
    });
    await restartedRuntime.ready();
    await restartedRuntime.start();
    await expect(replayed.promise).resolves.toEqual({
        claimed: 1,
        published: 1,
        failed: 0,
    });
    const dispatcherRestartedAt = new Date().toISOString();
    await restartedRuntime.close();

    const worker = runtimeWorker(context, "dispatcher-restart-worker");
    context.workers.push(worker);
    await worker.start();
    await worker.ready();
    const terminal = await waitForTerminal(
        context.runs,
        submitted.runId,
        CALLER_ID,
    );
    await worker.close();
    const attempts = await readAttempts(context.pool, submitted.runId);
    expect(attempts).toEqual([
        { number: 1, status: "succeeded", resultCode: "SUCCEEDED" },
    ]);
    return scenarioEvidence(
        "dispatcher_publish_before_ack",
        submitted.runId,
        terminal,
        attempts,
        context,
        {
            acceptedAt,
            firstClaimedAt,
            firstPublishedAt,
            firstDispatcherStoppedAt,
            dispatcherRestartedAt,
            terminalAt: terminalFinishedAt(terminal),
        },
        {
            firstDispatcherFaultObserved: true,
            duplicatePublicationDeduplicated: true,
        },
    );
}

async function fencingScenario(
    context: DrillContext & Readonly<{ inspector: Queue<ProcessWorkJob> }>,
): Promise<DrillScenario> {
    const acceptedAt = new Date().toISOString();
    const submitted = await submit(context.runs, "fencing");
    await expect(
        createOutboxDispatcher({
            outbox: context.outbox,
            queue: context.queue,
        }).dispatchOnce(),
    ).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    const staleToken = randomUUID();
    const claimedAt = new Date().toISOString();
    const claim = await context.store.claim({
        runId: submitted.runId,
        claimToken: staleToken,
        claimedAt,
    });
    expect(claim?.attemptNumber).toBe(1);
    const duplicateConsumer = createBullMqProcessWorker({
        redisUrl: redisUrl as string,
        queueName: defaultProcessWorkQueueName,
        prefix: defaultProcessWorkQueuePrefix,
        workerName: "duplicate-consumer",
        worker: ignoredWorker,
        onError: () => {},
    });
    context.workers.push(duplicateConsumer);
    await duplicateConsumer.start();
    await duplicateConsumer.ready();
    await waitForJobState(context.inspector, submitted.runId, "completed");
    await duplicateConsumer.close();
    await delay(170);
    const takeoverStartedAt = new Date().toISOString();
    await expect(
        createProcessRunReconciler({
            store: createPostgresProcessRunRecoverySource({
                pool: context.pool,
            }),
            queue: context.queue,
            queuedAgeMs: 1,
        }).reconcileOnce(),
    ).resolves.toEqual({ found: 1, enqueued: 1, duplicates: 0, failed: 0 });
    context.control.prepareFencing(submitted.runId);
    const worker = runtimeWorker(context, "fencing-worker");
    context.workers.push(worker);
    await worker.start();
    await worker.ready();
    await context.control.waitForFencingStart(submitted.runId);
    const staleCompletionAttemptedAt = new Date().toISOString();
    expect(
        await context.store.complete({
            runId: submitted.runId,
            claimToken: staleToken,
            completedAt: new Date().toISOString(),
            completion: {
                status: "succeeded",
                output: { proof: "late result must be fenced" },
            },
        }),
    ).toBe(false);
    context.control.releaseFencing(submitted.runId);
    const terminal = await waitForTerminal(
        context.runs,
        submitted.runId,
        CALLER_ID,
    );
    const beforeDuplicate = await readAttempts(context.pool, submitted.runId);
    expect(beforeDuplicate).toEqual([
        { number: 1, status: "abandoned", resultCode: "CLAIM_EXPIRED" },
        { number: 2, status: "succeeded", resultCode: "SUCCEEDED" },
    ]);
    expect(await context.queue.enqueue(job(submitted.runId))).toBe("enqueued");
    await waitForJobState(context.inspector, submitted.runId, "completed");
    await worker.close();
    const attempts = await readAttempts(context.pool, submitted.runId);
    expect(attempts).toEqual(beforeDuplicate);
    return scenarioEvidence(
        "stale_claim_and_duplicate_job",
        submitted.runId,
        terminal,
        attempts,
        context,
        {
            acceptedAt,
            claimedAt,
            takeoverStartedAt,
            staleCompletionAttemptedAt,
            terminalAt: terminalFinishedAt(terminal),
        },
        {
            staleCompletionRejected: true,
            terminalDuplicateIgnored: true,
        },
    );
}

async function rollingUpgradeScenario(
    context: DrillContext & Readonly<{ inspector: Queue<ProcessWorkJob> }>,
): Promise<DrillScenario> {
    const acceptedAt = new Date().toISOString();
    const submitted = await submit(context.runs, "rolling");
    context.control.prepareRolling(submitted.runId);
    await expect(
        createOutboxDispatcher({
            outbox: context.outbox,
            queue: context.queue,
        }).dispatchOnce(),
    ).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    const oldWorker = runtimeWorker(context, "rolling-old", {
        shutdownGraceMs: 50,
        lockDurationMs: 250,
        stalledIntervalMs: 100,
        maxStalledCount: 2,
    });
    context.workers.push(oldWorker);
    await oldWorker.start();
    await oldWorker.ready();
    await context.control.waitForRollingStart(submitted.runId);
    const newWorker = runtimeWorker(context, "rolling-new", {
        shutdownGraceMs: 1_000,
        lockDurationMs: 250,
        stalledIntervalMs: 100,
        maxStalledCount: 2,
    });
    context.workers.push(newWorker);
    await newWorker.start();
    await newWorker.ready();
    const newWorkerReadyAt = new Date().toISOString();
    const oldWorkerStopStartedAt = new Date().toISOString();
    const oldWorkerStopStartedMs = performance.now();
    await oldWorker.close();
    const shutdownElapsedMs = performance.now() - oldWorkerStopStartedMs;
    const oldWorkerStoppedAt = new Date().toISOString();
    expect(shutdownElapsedMs).toBeGreaterThanOrEqual(50);
    expect(shutdownElapsedMs).toBeLessThan(1_000);
    await waitForJobState(context.inspector, submitted.runId, "completed");
    await expect(
        createProcessRunReconciler({
            store: createPostgresProcessRunRecoverySource({
                pool: context.pool,
            }),
            queue: context.queue,
            queuedAgeMs: 1,
        }).reconcileOnce(),
    ).resolves.toEqual({ found: 1, enqueued: 1, duplicates: 0, failed: 0 });
    const recoveryEnqueuedAt = new Date().toISOString();
    const terminal = await waitForTerminal(
        context.runs,
        submitted.runId,
        CALLER_ID,
        8_000,
    );
    await newWorker.close();
    const attempts = await readAttempts(context.pool, submitted.runId);
    expect(attempts).toEqual([
        { number: 1, status: "abandoned", resultCode: "CLAIM_RELEASED" },
        { number: 2, status: "succeeded", resultCode: "SUCCEEDED" },
    ]);
    expect(newWorkerReadyAt <= oldWorkerStopStartedAt).toBe(true);
    return scenarioEvidence(
        "ready_first_rolling_shutdown",
        submitted.runId,
        terminal,
        attempts,
        context,
        {
            acceptedAt,
            newWorkerReadyAt,
            oldWorkerStopStartedAt,
            oldWorkerStoppedAt,
            recoveryEnqueuedAt,
            terminalAt: terminalFinishedAt(terminal),
        },
        {
            newWorkerReadyBeforeOldStop: true,
            shutdownGraceMs: 50,
            shutdownElapsedMs: Math.round(shutdownElapsedMs),
            oldClaimReleased: true,
        },
    );
}

function dispatcherRuntime(
    context: Pick<DrillContext, "pool" | "queue">,
    dispatcher: Parameters<
        typeof createProcessDispatcherRuntime
    >[0]["dispatcher"],
    onError: Parameters<
        typeof createProcessDispatcherRuntime
    >[0]["onError"] = () => {},
) {
    return createProcessDispatcherRuntime({
        dispatcher,
        reconciler: {
            reconcileOnce: async () => ({
                found: 0,
                enqueued: 0,
                duplicates: 0,
                failed: 0,
            }),
        },
        databaseReady: async () => {
            await context.pool.query("SELECT 1");
        },
        queueReady: context.queue.ready,
        closeResources: async () => {},
        dispatchIntervalMs: 60_000,
        reconciliationIntervalMs: 60_000,
        onError,
    });
}

function runtimeWorker(
    context: Pick<DrillContext, "registry" | "store">,
    workerName: string,
    options: Readonly<{
        shutdownGraceMs?: number;
        lockDurationMs?: number;
        stalledIntervalMs?: number;
        maxStalledCount?: number;
    }> = {},
) {
    return createBullMqProcessWorker({
        redisUrl: redisUrl as string,
        workerName,
        worker: createProcessWorker({
            registry: context.registry,
            store: context.store,
            attemptRunner: createProcessAttemptRunner({
                processTimeoutMs: 5_000,
            }),
        }),
        ...options,
        onError: () => {},
    });
}

type DrillControl = ReturnType<typeof createDrillControl>;

function createDrillControl() {
    const invocations = new Map<string, number>();
    const effectAttempts = new Map<string, number>();
    const effects = new Set<string>();
    const fencingStarted = new Map<string, () => void>();
    const fencingStart = new Map<string, Promise<void>>();
    const fencingReleased = new Map<string, () => void>();
    const fencingRelease = new Map<string, Promise<void>>();
    const rollingStarted = new Map<string, () => void>();
    const rollingStart = new Map<string, Promise<void>>();
    return Object.freeze({
        invoke: async (
            runId: string,
            mode: "dispatcher" | "fencing" | "rolling",
            signal: AbortSignal,
        ) => {
            const invocation = (invocations.get(runId) ?? 0) + 1;
            invocations.set(runId, invocation);
            effectAttempts.set(runId, (effectAttempts.get(runId) ?? 0) + 1);
            effects.add(runId);
            if (mode === "rolling" && invocation === 1) {
                rollingStarted.get(runId)?.();
                if (!signal.aborted) {
                    await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), {
                            once: true,
                        }),
                    );
                }
                return { proof: "cancelled old execution" };
            }
            if (mode === "fencing") {
                fencingStarted.get(runId)?.();
                const release = fencingRelease.get(runId);
                if (!release) throw new Error("Fencing drill was not prepared");
                await Promise.race([release, waitForAbort(signal)]);
                if (signal.aborted) return { proof: "cancelled fencing drill" };
            }
            return { proof: `idempotent effect for ${runId}` };
        },
        prepareRolling: (runId: string) => {
            rollingStart.set(
                runId,
                new Promise<void>((resolve) => {
                    rollingStarted.set(runId, resolve);
                }),
            );
        },
        prepareFencing: (runId: string) => {
            fencingStart.set(
                runId,
                new Promise<void>((resolve) => {
                    fencingStarted.set(runId, resolve);
                }),
            );
            fencingRelease.set(
                runId,
                new Promise<void>((resolve) => {
                    fencingReleased.set(runId, resolve);
                }),
            );
        },
        waitForFencingStart: (runId: string) => {
            const started = fencingStart.get(runId);
            if (!started) throw new Error("Fencing drill was not prepared");
            return started;
        },
        releaseFencing: (runId: string) => fencingReleased.get(runId)?.(),
        waitForRollingStart: (runId: string) => {
            const started = rollingStart.get(runId);
            if (!started) throw new Error("Rolling drill was not prepared");
            return started;
        },
        invocationCount: (runId: string) => invocations.get(runId) ?? 0,
        effectAttemptCount: (runId: string) => effectAttempts.get(runId) ?? 0,
        effectCount: (runId: string) => (effects.has(runId) ? 1 : 0),
    });
}

function createDrillRegistry(control: ReturnType<typeof createDrillControl>) {
    const mode = z.enum(["dispatcher", "fencing", "rolling"]);
    return createProcessRegistry([
        defineProcessRegistration({
            id: "dispatcher-worker-fault-drill",
            version: "v1",
            inputSchema: z.strictObject({ mode }),
            outputSchema: z.strictObject({ proof: z.string() }),
            execute: (input, context) =>
                control.invoke(context.runId, input.mode, context.signal),
        }),
    ]);
}

async function submit(
    runs: ReturnType<typeof createAsyncProcessRuns>,
    mode: "dispatcher" | "fencing" | "rolling",
) {
    const submitted = await runs.submit(
        {
            process: "dispatcher-worker-fault-drill",
            version: "v1",
            input: { mode },
        },
        { callerId: CALLER_ID, idempotencyKey: `drill-${mode}` },
    );
    if (!submitted.accepted) throw new Error("Expected accepted drill Run");
    return submitted;
}

async function readAttempts(pool: Pool, runId: string) {
    const result = await pool.query<{
        attempt_number: number;
        status: string;
        result_code: string;
    }>(
        `SELECT attempt_number, status, result_code
         FROM process_run_attempts
         WHERE run_id = $1
         ORDER BY attempt_number`,
        [runId],
    );
    return result.rows.map((row) => ({
        number: row.attempt_number,
        status: row.status,
        resultCode: row.result_code,
    }));
}

async function waitForTerminal(
    runs: ReturnType<typeof createAsyncProcessRuns>,
    runId: string,
    callerId: string,
    timeoutMs = 5_000,
): Promise<Extract<ProcessRunView, { status: "succeeded" | "failed" }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const run = await runs.find(runId, { callerId });
        if (run?.status === "succeeded" || run?.status === "failed") {
            return run;
        }
        await delay(20);
    }
    throw new Error(`Drill Run ${runId} did not reach a terminal state`);
}

async function waitForJobState(
    queue: Queue<ProcessWorkJob>,
    runId: string,
    state: string,
): Promise<void> {
    const deadline = Date.now() + 5_000;
    let observed = "missing";
    while (Date.now() < deadline) {
        const jobValue = await queue.getJob(runId);
        observed = jobValue ? await jobValue.getState() : "missing";
        if (observed === state) return;
        await delay(20);
    }
    throw new Error(
        `Drill Queue Job ${runId} did not reach ${state}; last state was ${observed}`,
    );
}

async function authoritativeRunCount(pool: Pool, runId: string): Promise<1> {
    const result = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM process_runs WHERE run_id = $1",
        [runId],
    );
    expect(result.rows[0]?.count).toBe(1);
    return 1;
}

async function terminalEventCount(pool: Pool, runId: string): Promise<1> {
    const result = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM process_events
         WHERE run_id = $1
           AND event_type IN ('process_run.succeeded', 'process_run.failed')`,
        [runId],
    );
    expect(result.rows[0]?.count).toBe(1);
    return 1;
}

async function scenarioEvidence(
    name: DrillScenario["name"],
    runId: string,
    terminal: Extract<ProcessRunView, { status: "succeeded" | "failed" }>,
    attempts: DrillScenario["attempts"],
    context: DrillContext,
    timeline: DrillScenario["timeline"],
    observations: DrillScenario["observations"],
): Promise<DrillScenario> {
    expect(terminal.status).toBe("succeeded");
    expect(context.control.effectCount(runId)).toBe(1);
    return Object.freeze({
        name,
        runId,
        terminalStatus: "succeeded" as const,
        authoritativeRunCount: await authoritativeRunCount(context.pool, runId),
        terminalEventCount: await terminalEventCount(context.pool, runId),
        idempotentEffectCount: 1 as const,
        attempts,
        timeline: Object.freeze(timeline),
        observations: Object.freeze({
            ...observations,
            capabilityInvocationCount: context.control.invocationCount(runId),
            capabilityEffectAttemptCount:
                context.control.effectAttemptCount(runId),
        }),
    });
}

function terminalFinishedAt(
    terminal: Extract<ProcessRunView, { status: "succeeded" | "failed" }>,
): string {
    return terminal.finishedAt;
}

function job(runId: string): ProcessWorkJob {
    return { schemaVersion: 1, runId };
}

const ignoredWorker: ProcessWorker = {
    process: async () => "ignored",
    releaseActive: async () => 0,
};

async function writeEvidence(evidence: unknown): Promise<void> {
    const target = process.env.ASYNC_DISPATCHER_WORKER_DRILL_EVIDENCE_FILE;
    if (!target) return;
    const file = path.resolve(target);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, {
        mode: 0o600,
    });
}

function drillRevision(): string {
    const revision =
        process.env.ASYNC_DISPATCHER_WORKER_DRILL_REVISION ?? "f".repeat(40);
    if (!/^[0-9a-f]{40}$/.test(revision)) {
        throw new Error("Dispatcher/Worker drill revision must be a full SHA");
    }
    return revision;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
    );
}

function deferred<Value>() {
    let resolvePromise: (value: Value) => void = () => {};
    const promise = new Promise<Value>((resolve) => {
        resolvePromise = resolve;
    });
    return Object.freeze({ promise, resolve: resolvePromise });
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

function assertTestDatabase(url: string): void {
    if (!new URL(url).pathname.slice(1).endsWith("_test")) {
        throw new Error("Dispatcher/Worker drill requires a *_test database");
    }
}

function assertTestRedis(value: string): void {
    const url = new URL(value);
    const database = Number(url.pathname.slice(1));
    if (
        url.protocol !== "redis:" ||
        (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
        !Number.isInteger(database) ||
        database < 1
    ) {
        throw new Error(
            "Dispatcher/Worker drill requires local Redis with a non-zero database",
        );
    }
}

const CALLER_ID = "operator:dispatcher-worker-drill";
const RETENTION = {
    acceptedInputMs: 86_400_000,
    resultMs: 604_800_000,
    metadataMs: 2_592_000_000,
} as const;
