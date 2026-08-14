import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { Redis } from "ioredis";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAsyncProcessRuns } from "../src/process-runs/index.js";
import type { AsyncOperationalLogRecord } from "../src/process-runs/ops/logging.js";
import {
    createPostgresAsyncOperations,
    createPostgresAsyncReleaseReadiness,
} from "../src/process-runs/ops/postgres.js";
import {
    createOutboxDispatcher,
    createWebhookOutboxDispatcher,
} from "../src/process-runs/outbox/dispatcher.js";
import { createPostgresProcessOutbox } from "../src/process-runs/outbox/postgres.js";
import {
    createBullMqProcessWorker,
    createBullMqProcessWorkQueue,
} from "../src/process-runs/queue/bullmq.js";
import { createPostgresProcessRunStore } from "../src/process-runs/store/postgres.js";
import { createProcessWorker } from "../src/process-runs/worker/index.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    defineProcessRegistration,
} from "../src/process-runtime/index.js";
import {
    createStandardWebhookHttpSender,
    createWebhookDeliveryWorker,
} from "../src/webhooks/delivery/index.js";
import { createWebhookTargetPolicy } from "../src/webhooks/delivery/target-policy.js";
import { createPostgresWebhookOutbox } from "../src/webhooks/outbox/postgres.js";
import {
    createBullMqWebhookWorker,
    createBullMqWebhookWorkQueue,
} from "../src/webhooks/queue/bullmq.js";
import {
    createPostgresWebhookDeliveryStore,
    type PostgresWebhookDeliveryStore,
} from "../src/webhooks/store/postgres.js";
import { createWebhookSecretCipher } from "../src/webhooks/store/secret-cipher.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_TEST_URL;
if (process.env.RUN_ASYNC_INTEGRATION === "1" && (!databaseUrl || !redisUrl)) {
    throw new Error(
        "POSTGRES_TEST_DATABASE_URL and REDIS_TEST_URL are required for the Webhook observability drill",
    );
}

const integrationDescribe =
    databaseUrl && redisUrl ? describe.sequential : describe.skip;

integrationDescribe("Webhook isolation and async observability drill", () => {
    let pool: Pool;
    let redis: Redis;
    let receiver: Server | undefined;

    beforeAll(async () => {
        assertTestDatabase(databaseUrl as string);
        assertTestRedis(redisUrl as string);
        pool = new Pool({ connectionString: databaseUrl, max: 8 });
        redis = new Redis(redisUrl as string, { maxRetriesPerRequest: 1 });
        redis.on("error", () => {});
        await pool.query("DROP SCHEMA public CASCADE");
        await pool.query("CREATE SCHEMA public");
        await migrate(databaseUrl as string);
        await redis.flushdb();
    }, 30_000);

    afterAll(async () => {
        redis?.disconnect();
        await Promise.all([pool?.end(), closeServer(receiver)]);
    });

    it("keeps Process execution independent while Webhooks fail and gates canary on safe signals", async () => {
        const startedAt = new Date().toISOString();
        const logs: AsyncOperationalLogRecord[] = [];
        const received: ReceiverAttempt[] = [];
        let endpointAvailable = false;
        receiver = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const payload = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
            ) as {
                eventId: string;
                data: { runId: string };
            };
            received.push({
                eventId: String(request.headers["webhook-id"]),
                payloadEventId: payload.eventId,
                runId: payload.data.runId,
                httpStatus: endpointAvailable ? 204 : 503,
                receivedAt: new Date().toISOString(),
            });
            if (endpointAvailable) {
                response.writeHead(204).end();
                return;
            }
            response.writeHead(503, { "retry-after": "1" });
            response.end(REMOTE_RESPONSE_SENTINEL);
        });
        const endpointUrl = await listen(receiver);
        const secret = `whsec_${Buffer.alloc(32, 17).toString("base64")}`;
        const targetPolicy = createWebhookTargetPolicy({
            allowInsecureHttp: true,
            allowUnsafeAddresses: true,
        });
        const webhookStore = createPostgresWebhookDeliveryStore({
            pool,
            secretCipher: createWebhookSecretCipher({
                key: Buffer.alloc(32, 19),
            }),
            targetPolicy,
            claimLeaseMs: 2_000,
        });
        await webhookStore.provisionEndpoint({
            endpointId: ENDPOINT_ID,
            ownerId: CALLER_ID,
            actorId: ACTOR_ID,
            url: endpointUrl,
            secret,
            createdAt: startedAt,
        });

        const registry = drillRegistry();
        const processStore = createPostgresProcessRunStore({
            pool,
            retention: RETENTION,
        });
        const runs = createAsyncProcessRuns({ registry, store: processStore });
        const processQueue = createBullMqProcessWorkQueue({
            redisUrl: redisUrl as string,
            onError: () => {},
        });
        const webhookQueue = createBullMqWebhookWorkQueue({
            redisUrl: redisUrl as string,
            onError: () => {},
        });
        const processDispatcher = createOutboxDispatcher({
            outbox: createPostgresProcessOutbox({ pool }),
            queue: processQueue,
            logSink: (record) => logs.push(record),
        });
        const webhookDispatcher = createWebhookOutboxDispatcher({
            outbox: createPostgresWebhookOutbox({ pool }),
            queue: webhookQueue,
            logSink: (record) => logs.push(record),
        });
        const processWorker = createBullMqProcessWorker({
            redisUrl: redisUrl as string,
            onError: () => {},
            worker: createProcessWorker({
                registry,
                store: processStore,
                attemptRunner: createProcessAttemptRunner({
                    processTimeoutMs: 5_000,
                }),
                logSink: (record) => logs.push(record),
            }),
        });
        const webhookWorker = createBullMqWebhookWorker({
            redisUrl: redisUrl as string,
            onError: () => {},
            worker: createWebhookDeliveryWorker({
                store: webhookStore,
                sender: createStandardWebhookHttpSender({
                    timeoutMs: 500,
                    targetPolicy,
                }),
                retryPolicy: {
                    maximumAttempts: 2,
                    initialBackoffMs: RETRY_DELAY_MS,
                    maximumBackoffMs: RETRY_DELAY_MS,
                    maximumRetryAfterMs: RETRY_DELAY_MS,
                    deliveryHorizonMs: 15_000,
                    jitterPercent: 0,
                },
                random: () => 0.5,
                logSink: (record) => logs.push(record),
            }),
        });

        try {
            await Promise.all([processQueue.ready(), webhookQueue.ready()]);
            await Promise.all([processWorker.start(), webhookWorker.start()]);

            const first = await executeWhileWebhookUnavailable({
                value: "first",
                runs,
                processDispatcher,
                webhookDispatcher,
                webhookStore,
            });
            const second = await executeWhileWebhookUnavailable({
                value: "second",
                runs,
                processDispatcher,
                webhookDispatcher,
                webhookStore,
            });
            const isolatedRuns = [first, second];
            expect(
                isolatedRuns.every(
                    (run) => run.terminalElapsedMs < RETRY_DELAY_MS,
                ),
            ).toBe(true);
            expect(received).toHaveLength(2);

            const readinessOptions = {
                pool,
                globalBacklogLimit: 100,
                stuckRunAgeMs: 60_000,
                maximumStuckRuns: 0,
                maximumOutboxLagMs: 1_000,
                recoveryMaxAgeMs: 60_000,
            } as const;
            await expect(
                createPostgresAsyncReleaseReadiness({
                    ...readinessOptions,
                    stage: "canary",
                })(),
            ).rejects.toThrow("recovery gate");
            await insertFreshOperationalSignals(pool);
            await expect(
                createPostgresAsyncReleaseReadiness({
                    ...readinessOptions,
                    stage: "canary",
                })(),
            ).resolves.toBeUndefined();
            await expect(
                createPostgresAsyncReleaseReadiness({
                    ...readinessOptions,
                    stage: "production",
                })(),
            ).resolves.toBeUndefined();

            const measuredAt = new Date().toISOString();
            const operations = createPostgresAsyncOperations({
                pool,
                recentWindowMs: 60_000,
                stuckRunAgeMs: 60_000,
            });
            const [persistence, processSnapshot, webhookSnapshot] =
                await Promise.all([
                    operations.snapshot({ asOf: measuredAt }),
                    processQueue.snapshot(new Date(measuredAt).getTime()),
                    webhookQueue.snapshot(new Date(measuredAt).getTime()),
                ]);
            expect(persistence.runs).toMatchObject({
                queued: 0,
                running: 0,
                succeededRecent: 2,
                stuck: 0,
            });
            expect(persistence.outbox).toMatchObject({
                processPending: 0,
                webhookPending: 0,
                oldestProcessLagMs: 0,
                oldestWebhookLagMs: 0,
            });
            expect(persistence.webhooks.pending).toBe(2);
            expect(persistence.cleanup.lastCompletedAt).toBeDefined();
            expect(persistence.recovery).toMatchObject({
                lastStatus: "completed",
                lastFailedItems: 0,
            });
            expect(persistence.storage.asyncTablesBytes).toBeGreaterThan(0);
            expect(processSnapshot).toMatchObject({ waiting: 0, active: 0 });

            endpointAvailable = true;
            await waitForRetryAvailability(pool);
            await expect(webhookDispatcher.dispatchOnce()).resolves.toEqual({
                claimed: 2,
                published: 2,
                failed: 0,
            });
            await Promise.all(
                isolatedRuns.map((run) =>
                    waitForDeliveryStatus(webhookStore, run.runId, "succeeded"),
                ),
            );

            const deliveries = await Promise.all(
                isolatedRuns.map(async (run) => {
                    const delivery = await oneDelivery(webhookStore, run.runId);
                    const attempts = await webhookStore.findAttempts({
                        ownerId: CALLER_ID,
                        deliveryId: delivery.deliveryId,
                    });
                    expect(attempts).toEqual([
                        expect.objectContaining({
                            attemptNumber: 1,
                            outcome: "failed",
                            httpStatus: 503,
                        }),
                        expect.objectContaining({
                            attemptNumber: 2,
                            outcome: "succeeded",
                            httpStatus: 204,
                        }),
                    ]);
                    const receiverAttempts = received.filter(
                        (attempt) => attempt.runId === run.runId,
                    );
                    expect(receiverAttempts).toHaveLength(2);
                    expect(
                        receiverAttempts.every(
                            (attempt) =>
                                attempt.eventId === delivery.eventId &&
                                attempt.payloadEventId === delivery.eventId,
                        ),
                    ).toBe(true);
                    return {
                        deliveryId: delivery.deliveryId,
                        eventId: delivery.eventId,
                        stableEventId: true,
                        attempts: attempts.map((attempt) => ({
                            attemptNumber: attempt.attemptNumber,
                            outcome: attempt.outcome,
                            httpStatus: attempt.httpStatus,
                        })),
                    };
                }),
            );

            const serializedLogs = JSON.stringify(logs);
            for (const forbidden of [
                endpointUrl,
                secret,
                INPUT_SENTINEL,
                REMOTE_RESPONSE_SENTINEL,
                "payload",
                "idempotency",
                "authorization",
            ]) {
                expect(serializedLogs.toLowerCase()).not.toContain(
                    forbidden.toLowerCase(),
                );
            }

            await writeEvidence({
                schemaVersion: 1,
                event: "async_webhook_observability_drill_completed",
                environment: "isolated-staging",
                revision: drillRevision(),
                actor: ACTOR_ID,
                startedAt,
                completedAt: new Date().toISOString(),
                productionTrafficAffected: false,
                runs: isolatedRuns.map((run) => ({
                    runId: run.runId,
                    status: "succeeded",
                    terminalElapsedMs: run.terminalElapsedMs,
                    terminalBeforeWebhookSuccess: true,
                })),
                deliveries,
                isolation: {
                    webhookFailuresObserved: 2,
                    processQueueLatencyWithinRetryWindow: true,
                    processQueueWaitingDuringWebhookBacklog:
                        processSnapshot.waiting,
                    webhookPendingDuringSnapshot: persistence.webhooks.pending,
                    futureRetryExcludedFromCurrentOutboxLag:
                        persistence.outbox.webhookPending === 0 &&
                        persistence.outbox.oldestWebhookLagMs === 0,
                },
                readiness: {
                    rejectedWithoutRecovery: true,
                    canaryPassed: true,
                    productionPassed: true,
                },
                snapshot: {
                    schemaVersion: 1,
                    measuredAt,
                    persistence,
                    queues: {
                        process: processSnapshot,
                        webhook: webhookSnapshot,
                    },
                },
                correlationKeys: ["runId", "eventId", "deliveryId"],
                timeline: logs,
                evidenceContainsOnlySafeFields: true,
            });
        } finally {
            await Promise.allSettled([
                processWorker.close(),
                webhookWorker.close(),
                processQueue.close(),
                webhookQueue.close(),
            ]);
        }
    }, 30_000);
});

function drillRegistry() {
    return createProcessRegistry([
        defineProcessRegistration({
            id: "webhook-observability-drill",
            version: "v1",
            inputSchema: z.strictObject({ value: z.string() }),
            outputSchema: z.strictObject({ value: z.string() }),
            execute: async (input) => ({ value: `completed:${input.value}` }),
        }),
    ]);
}

async function executeWhileWebhookUnavailable(request: {
    value: string;
    runs: ReturnType<typeof createAsyncProcessRuns>;
    processDispatcher: ReturnType<typeof createOutboxDispatcher>;
    webhookDispatcher: ReturnType<typeof createWebhookOutboxDispatcher>;
    webhookStore: PostgresWebhookDeliveryStore;
}) {
    const started = performance.now();
    const submitted = await request.runs.submit(
        {
            process: "webhook-observability-drill",
            version: "v1",
            input: { value: `${INPUT_SENTINEL}-${request.value}` },
        },
        {
            callerId: CALLER_ID,
            idempotencyKey: `webhook-observability-${request.value}`,
        },
    );
    if (!submitted.accepted) throw new Error("Expected accepted Process Run");
    await expect(request.processDispatcher.dispatchOnce()).resolves.toEqual({
        claimed: 1,
        published: 1,
        failed: 0,
    });
    await waitForRunTerminal(request.runs, submitted.runId);
    const terminalElapsedMs = Math.round(performance.now() - started);
    await expect(request.webhookDispatcher.dispatchOnce()).resolves.toEqual({
        claimed: 1,
        published: 1,
        failed: 0,
    });
    const delivery = await oneDelivery(request.webhookStore, submitted.runId);
    await waitForAttemptCount(request.webhookStore, delivery.deliveryId, 1);
    await expect(
        request.runs.find(submitted.runId, { callerId: CALLER_ID }),
    ).resolves.toMatchObject({ status: "succeeded" });
    return { runId: submitted.runId, terminalElapsedMs };
}

async function oneDelivery(store: PostgresWebhookDeliveryStore, runId: string) {
    const deliveries = await store.findByRun({
        ownerId: CALLER_ID,
        runIds: [runId],
    });
    const delivery = deliveries[0];
    if (!delivery) throw new Error(`Delivery for Run ${runId} was not found`);
    return delivery;
}

async function waitForRunTerminal(
    runs: ReturnType<typeof createAsyncProcessRuns>,
    runId: string,
) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const run = await runs.find(runId, { callerId: CALLER_ID });
        if (run?.status === "succeeded" || run?.status === "failed") return run;
        await delay(20);
    }
    throw new Error(`Process Run ${runId} did not reach terminal`);
}

async function waitForAttemptCount(
    store: PostgresWebhookDeliveryStore,
    deliveryId: string,
    expected: number,
) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const attempts = await store.findAttempts({
            ownerId: CALLER_ID,
            deliveryId,
        });
        if (attempts.length >= expected) return attempts;
        await delay(20);
    }
    throw new Error(
        `Delivery ${deliveryId} did not record ${expected} Attempts`,
    );
}

async function waitForDeliveryStatus(
    store: PostgresWebhookDeliveryStore,
    runId: string,
    expected: string,
) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const delivery = await oneDelivery(store, runId);
        if (delivery.status === expected) return delivery;
        await delay(20);
    }
    throw new Error(`Delivery for Run ${runId} did not reach ${expected}`);
}

async function waitForRetryAvailability(pool: Pool) {
    const result = await pool.query<{ next_attempt_at: Date }>(`
      SELECT min(next_attempt_at) AS next_attempt_at
      FROM webhook_deliveries
      WHERE status = 'pending'
    `);
    const nextAttemptAt = result.rows[0]?.next_attempt_at;
    if (!nextAttemptAt) throw new Error("Expected scheduled Webhook retries");
    await delay(Math.max(0, nextAttemptAt.getTime() - Date.now() + 50));
}

async function insertFreshOperationalSignals(pool: Pool) {
    const now = new Date().toISOString();
    await pool.query(
        `
          INSERT INTO retention_cleanup_batches (
            cleanup_id, as_of, examined_count, input_deleted_count,
            result_deleted_count, delivery_attempt_deleted_count,
            run_deleted_count, deferred_run_count, completed_at
          )
          VALUES ($1, $2, 0, 0, 0, 0, 0, 0, $2)
        `,
        [CLEANUP_ID, now],
    );
    await pool.query(
        `
          INSERT INTO queue_recovery_runs (
            recovery_id, trigger_kind, recovery_mode, dry_run, actor_id,
            as_of, queued_before, status, started_at, completed_at
          )
          VALUES ($1, 'manual', 'all', true, $2, $3, $3, 'completed', $3, $3)
        `,
        [RECOVERY_ID, ACTOR_ID, now],
    );
}

async function listen(server: Server) {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Expected Webhook receiver address");
    return `http://127.0.0.1:${address.port}/webhook`;
}

async function closeServer(server: Server | undefined) {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}

async function writeEvidence(evidence: unknown) {
    const target = process.env.ASYNC_WEBHOOK_DRILL_EVIDENCE_FILE;
    if (!target) return;
    const file = path.resolve(target);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, {
        mode: 0o600,
    });
}

function drillRevision() {
    const revision = process.env.ASYNC_WEBHOOK_DRILL_REVISION ?? "f".repeat(40);
    if (!/^[0-9a-f]{40}$/.test(revision))
        throw new Error("Webhook drill revision must be a full SHA");
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
        throw new Error("Webhook drill requires a *_test database");
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
            "Webhook drill requires local Redis with a non-zero database",
        );
    }
}

type ReceiverAttempt = Readonly<{
    eventId: string;
    payloadEventId: string;
    runId: string;
    httpStatus: number;
    receivedAt: string;
}>;

const CALLER_ID = "caller:webhook-observability-drill";
const ACTOR_ID = "operator:webhook-observability-drill";
const ENDPOINT_ID = "20000000-0000-4000-8000-000000000150";
const CLEANUP_ID = "30000000-0000-4000-8000-000000000150";
const RECOVERY_ID = "40000000-0000-4000-8000-000000000150";
const RETRY_DELAY_MS = 3_000;
const INPUT_SENTINEL = "PRIVATE-BUSINESS-INPUT";
const REMOTE_RESPONSE_SENTINEL = "PRIVATE-REMOTE-RESPONSE";
const RETENTION = {
    acceptedInputMs: 86_400_000,
    resultMs: 604_800_000,
    metadataMs: 2_592_000_000,
} as const;
