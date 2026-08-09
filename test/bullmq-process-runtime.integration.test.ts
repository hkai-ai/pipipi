import {
    createServer as createHttpServer,
    type IncomingMessage,
    type Server,
} from "node:http";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
    callerIdentityHeader,
    gatewayAuthenticationHeader,
} from "../src/api/identity.js";
import { constructProcessingService } from "../src/app/api.js";
import { constructProcessDispatcherService } from "../src/app/process-dispatcher.js";
import { constructProcessWorkerService } from "../src/app/process-worker.js";
import { constructWebhookWorkerService } from "../src/app/webhook-worker.js";
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
import {
    createPostgresProcessRunRecoverySource,
    createPostgresProcessRunStore,
} from "../src/process-runs/store/postgres.js";
import type { ProcessWorker } from "../src/process-runs/worker/index.js";
import { createProcessWorker } from "../src/process-runs/worker/index.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    defineProcessRegistration,
    failProcess,
} from "../src/processes/runtime/index.js";
import { signStandardWebhook } from "../src/webhooks/delivery/signing.js";
import { createWebhookTargetPolicy } from "../src/webhooks/delivery/target-policy.js";
import {
    defaultWebhookWorkQueueName,
    defaultWebhookWorkQueuePrefix,
} from "../src/webhooks/queue/bullmq.js";
import { createPostgresWebhookDeliveryStore } from "../src/webhooks/store/postgres.js";
import { createWebhookSecretCipher } from "../src/webhooks/store/secret-cipher.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_TEST_URL;
if (process.env.RUN_ASYNC_INTEGRATION === "1" && (!databaseUrl || !redisUrl)) {
    throw new Error(
        "POSTGRES_TEST_DATABASE_URL and REDIS_TEST_URL are required for async integration tests",
    );
}

const integrationDescribe =
    databaseUrl && redisUrl ? describe.sequential : describe.skip;

integrationDescribe("BullMQ Process Runtime", () => {
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

    beforeEach(async () => {
        await pool.query(
            "TRUNCATE queue_recovery_runs, retention_cleanup_batches, webhook_endpoints, process_runs CASCADE",
        );
        await redis.flushdb();
    });

    afterAll(async () => {
        await Promise.all([pool?.end(), redis?.quit()]);
    });

    it("dispatches two exact registrations through one minimal queue and persists both terminal outcomes", async () => {
        const registry = testRegistry();
        const store = createPostgresProcessRunStore({
            pool,
            retention: RETENTION,
        });
        const runs = createAsyncProcessRuns({ registry, store });
        const queue = createBullMqProcessWorkQueue({
            redisUrl: redisUrl as string,
        });
        const dispatcher = createOutboxDispatcher({
            outbox: createPostgresProcessOutbox({ pool }),
            queue,
        });
        const worker = createBullMqProcessWorker({
            redisUrl: redisUrl as string,
            worker: createProcessWorker({
                registry,
                store,
                attemptRunner: createProcessAttemptRunner({
                    processTimeoutMs: 5_000,
                }),
            }),
        });
        const inspector = new Queue<ProcessWorkJob>(
            defaultProcessWorkQueueName,
            {
                connection: { url: redisUrl as string },
                prefix: defaultProcessWorkQueuePrefix,
            },
        );

        try {
            await queue.ready();
            const succeeded = await runs.submit(
                {
                    process: "test-success",
                    version: "v1",
                    input: { value: "business-secret-success" },
                },
                { callerId: "caller-1", idempotencyKey: "success-1" },
            );
            const failed = await runs.submit(
                {
                    process: "test-failure",
                    version: "v2",
                    input: { value: "business-secret-failure" },
                },
                { callerId: "caller-1", idempotencyKey: "failure-1" },
            );
            if (!succeeded.accepted || !failed.accepted) {
                throw new Error("Expected accepted Process Runs");
            }

            await expect(dispatcher.dispatchOnce()).resolves.toEqual({
                claimed: 2,
                published: 2,
                failed: 0,
            });
            await expect(queue.snapshot()).resolves.toMatchObject({
                waiting: 2,
                active: 0,
                oldestRunnableAgeMs: expect.any(Number),
            });
            const jobs = await inspector.getJobs(["wait"]);
            expect(jobs).toHaveLength(2);
            expect(jobs.map((job) => job.queueName)).toEqual([
                defaultProcessWorkQueueName,
                defaultProcessWorkQueueName,
            ]);
            expect(jobs.map((job) => job.data)).toEqual(
                expect.arrayContaining([
                    { schemaVersion: 1, runId: succeeded.runId },
                    { schemaVersion: 1, runId: failed.runId },
                ]),
            );
            expect(JSON.stringify(jobs.map((job) => job.data))).not.toContain(
                "business-secret",
            );

            await worker.start();
            await expect(
                waitForTerminal(runs, succeeded.runId, "caller-1"),
            ).resolves.toMatchObject({
                status: "succeeded",
                process: "test-success",
                version: "v1",
                output: { value: "completed:business-secret-success" },
            });
            await expect(
                waitForTerminal(runs, failed.runId, "caller-1"),
            ).resolves.toMatchObject({
                status: "failed",
                process: "test-failure",
                version: "v2",
                error: {
                    code: "DEPENDENCY_FAILURE",
                    message: "The test dependency is unavailable",
                },
            });
            const persistence = await pool.query<{
                published: string;
                attempts: string;
            }>(`
        SELECT
          (SELECT count(*) FROM outbox_messages WHERE published_at IS NOT NULL)::text AS published,
          (SELECT count(*) FROM process_run_attempts)::text AS attempts
      `);
            expect(persistence.rows[0]).toEqual({
                published: "2",
                attempts: "2",
            });
        } finally {
            await Promise.allSettled([
                worker.close(),
                queue.close(),
                inspector.close(),
            ]);
        }
    }, 20_000);

    it("delays a declared transient retry and persists one successful terminal Run", async () => {
        const seenRunIds: string[] = [];
        let executionCount = 0;
        const process = defineProcessRegistration({
            id: "test-retry-safe",
            version: "v1",
            inputSchema: z.strictObject({ value: z.string() }),
            outputSchema: z.strictObject({ value: z.string() }),
            retryPolicy: {
                maximumAttempts: 3,
                retryableErrorCodes: ["DEPENDENCY_FAILURE"],
                backoff: { initialDelayMs: 500, maximumDelayMs: 1_000 },
            },
            execute: async (input, context) => {
                seenRunIds.push(context.runId);
                executionCount += 1;
                return executionCount === 1
                    ? failProcess(
                          "DEPENDENCY_FAILURE",
                          "The test dependency is unavailable",
                      )
                    : { value: `recovered:${input.value}` };
            },
        });
        const registry = createProcessRegistry([process]);
        const store = createPostgresProcessRunStore({
            pool,
            retention: RETENTION,
        });
        const runs = createAsyncProcessRuns({ registry, store });
        const queue = createBullMqProcessWorkQueue({
            redisUrl: redisUrl as string,
        });
        const dispatcher = createOutboxDispatcher({
            outbox: createPostgresProcessOutbox({ pool }),
            queue,
        });
        const worker = createBullMqProcessWorker({
            redisUrl: redisUrl as string,
            worker: createProcessWorker({
                registry,
                store,
                attemptRunner: createProcessAttemptRunner({
                    processTimeoutMs: 5_000,
                }),
            }),
        });

        try {
            const submitted = await runs.submit(
                {
                    process: "test-retry-safe",
                    version: "v1",
                    input: { value: "request" },
                },
                { callerId: "caller-retry", idempotencyKey: "safe-retry" },
            );
            if (!submitted.accepted)
                throw new Error("Expected accepted Process Run");
            await dispatcher.dispatchOnce();
            await worker.start();

            await expect(
                waitForStoredRun(
                    store,
                    submitted.runId,
                    "caller-retry",
                    (run) => run.status === "queued" && run.attemptCount === 1,
                ),
            ).resolves.toMatchObject({ status: "queued", attemptCount: 1 });
            await expect(
                waitForTerminal(runs, submitted.runId, "caller-retry"),
            ).resolves.toMatchObject({
                status: "succeeded",
                output: { value: "recovered:request" },
            });
            expect(seenRunIds).toEqual([submitted.runId, submitted.runId]);
            const attempts = await pool.query<{
                attempt_number: number;
                status: string;
                result_code: string;
            }>(`
        SELECT attempt_number, status, result_code
        FROM process_run_attempts
        ORDER BY attempt_number
      `);
            expect(attempts.rows).toEqual([
                {
                    attempt_number: 1,
                    status: "failed",
                    result_code: "DEPENDENCY_FAILURE",
                },
                {
                    attempt_number: 2,
                    status: "succeeded",
                    result_code: "SUCCEEDED",
                },
            ]);
        } finally {
            await Promise.allSettled([worker.close(), queue.close()]);
        }
    }, 20_000);

    it("retries a transient signed Webhook with one stable event ID on its isolated Queue", async () => {
        const received: Array<{
            body: string;
            headers: Record<string, string | string[] | undefined>;
        }> = [];
        const receiver = createHttpServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            received.push({
                body: Buffer.concat(chunks).toString("utf8"),
                headers: request.headers,
            });
            if (received.length === 1) {
                response.writeHead(503, { "retry-after": "1" }).end();
                return;
            }
            response.writeHead(204).end();
        });
        const receiverUrl = await listenHttpServer(receiver);
        const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
        const registry = testRegistry();
        const processStore = createPostgresProcessRunStore({
            pool,
            retention: RETENTION,
        });
        const deliveryStore = createPostgresWebhookDeliveryStore({
            pool,
            secretCipher: createWebhookSecretCipher({
                key: Buffer.alloc(32, 12),
            }),
            targetPolicy: createWebhookTargetPolicy({
                allowInsecureHttp: true,
                allowUnsafeAddresses: true,
            }),
        });
        await deliveryStore.provisionEndpoint({
            endpointId: "20000000-0000-4000-8000-000000000010",
            ownerId: "caller-webhook",
            actorId: "operator:test",
            url: receiverUrl,
            secret,
            createdAt: "2026-08-09T10:00:00.000Z",
        });
        const runs = createAsyncProcessRuns({ registry, store: processStore });
        const processQueue = createBullMqProcessWorkQueue({
            redisUrl: redisUrl as string,
        });
        const processDispatcher = createOutboxDispatcher({
            outbox: createPostgresProcessOutbox({ pool }),
            queue: processQueue,
        });
        const processWorker = createBullMqProcessWorker({
            redisUrl: redisUrl as string,
            worker: createProcessWorker({
                registry,
                store: processStore,
                attemptRunner: createProcessAttemptRunner({
                    processTimeoutMs: 5_000,
                }),
            }),
        });
        const webhookService = constructWebhookWorkerService({
            DATABASE_URL: databaseUrl,
            REDIS_URL: redisUrl,
            NODE_ENV: "test",
            WEBHOOK_ALLOW_INSECURE_HTTP: "true",
            WEBHOOK_TEST_ALLOW_UNSAFE_TARGETS: "true",
            WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString(
                "base64",
            ),
            WEBHOOK_REQUEST_TIMEOUT_MS: "1000",
            WEBHOOK_DELIVERY_CLAIM_LEASE_MS: "2000",
            WEBHOOK_OUTBOX_DISPATCH_INTERVAL_MS: "20",
            WEBHOOK_DELIVERY_MAX_ATTEMPTS: "2",
            WEBHOOK_DELIVERY_INITIAL_BACKOFF_MS: "1100",
            WEBHOOK_DELIVERY_MAX_BACKOFF_MS: "1100",
            WEBHOOK_DELIVERY_MAX_RETRY_AFTER_MS: "1100",
            WEBHOOK_DELIVERY_HORIZON_MS: "10000",
            WEBHOOK_DELIVERY_JITTER_PERCENT: "0",
        });
        await webhookService.application.listen();

        try {
            const succeeded = await runs.submit(
                {
                    process: "test-success",
                    version: "v1",
                    input: { value: "webhook-success-secret" },
                },
                {
                    callerId: "caller-webhook",
                    idempotencyKey: "webhook-success",
                },
            );
            const failed = await runs.submit(
                {
                    process: "test-failure",
                    version: "v2",
                    input: { value: "webhook-failure-secret" },
                },
                {
                    callerId: "caller-webhook",
                    idempotencyKey: "webhook-failure",
                },
            );
            if (!succeeded.accepted || !failed.accepted)
                throw new Error("Expected Runs");
            await processDispatcher.dispatchOnce();
            await processWorker.start();
            await Promise.all([
                waitForTerminal(runs, succeeded.runId, "caller-webhook"),
                waitForTerminal(runs, failed.runId, "caller-webhook"),
            ]);

            await waitForSuccessfulDeliveries(deliveryStore, [
                succeeded.runId,
                failed.runId,
            ]);
            const delivered = await deliveryStore.findByRun({
                ownerId: "caller-webhook",
                runIds: [succeeded.runId, failed.runId],
            });
            const webhookInspector = new Queue(defaultWebhookWorkQueueName, {
                connection: { url: redisUrl as string },
                prefix: defaultWebhookWorkQueuePrefix,
            });
            try {
                const jobs = await Promise.all(
                    delivered.map((delivery) =>
                        webhookInspector.getJob(delivery.deliveryId),
                    ),
                );
                expect(
                    jobs.every(
                        (job) => job?.queueName === defaultWebhookWorkQueueName,
                    ),
                ).toBe(true);
            } finally {
                await webhookInspector.close();
            }
            expect(received).toHaveLength(3);
            expect(
                [
                    ...new Set(
                        received.map((entry) => JSON.parse(entry.body).type),
                    ),
                ].sort(),
            ).toEqual(["process_run.failed", "process_run.succeeded"]);
            for (const entry of received) {
                const payload = JSON.parse(entry.body) as {
                    eventId: string;
                    data: { runId: string; resultLocation: string };
                };
                const eventId = entry.headers["webhook-id"];
                const timestamp = entry.headers["webhook-timestamp"];
                expect(eventId).toBe(payload.eventId);
                expect(entry.headers["webhook-signature"]).toBe(
                    signStandardWebhook({
                        messageId: String(eventId),
                        timestamp: String(timestamp),
                        payload: entry.body,
                        secret,
                    }),
                );
                expect(payload.data.resultLocation).toBe(
                    `/process-runs/${payload.data.runId}`,
                );
                expect(entry.body).not.toContain("webhook-success-secret");
                expect(entry.body).not.toContain("webhook-failure-secret");
                expect(entry.body).not.toContain("output");
            }
            const attempts = await Promise.all(
                delivered.map((delivery) =>
                    deliveryStore.findAttempts({
                        ownerId: "caller-webhook",
                        deliveryId: delivery.deliveryId,
                    }),
                ),
            );
            expect(attempts.map((chain) => chain.length).sort()).toEqual([
                1, 2,
            ]);
            const retried = attempts.find((chain) => chain.length === 2);
            expect(retried).toEqual([
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
            const eventGroups = new Map<string, typeof received>();
            for (const entry of received) {
                const eventId = String(entry.headers["webhook-id"]);
                eventGroups.set(eventId, [
                    ...(eventGroups.get(eventId) ?? []),
                    entry,
                ]);
            }
            const retriedRequests = [...eventGroups.values()].find(
                (entries) => entries.length === 2,
            );
            expect(retriedRequests).toHaveLength(2);
            expect(
                Number(retriedRequests?.[1]?.headers["webhook-timestamp"]),
            ).toBeGreaterThan(
                Number(retriedRequests?.[0]?.headers["webhook-timestamp"]),
            );
        } finally {
            await Promise.allSettled([
                processWorker.close(),
                processQueue.close(),
                webhookService.application.close(),
            ]);
            await closeHttpServer(receiver);
        }
    }, 20_000);

    it("deduplicates a repeated outbox publication by runId", async () => {
        const queue = createBullMqProcessWorkQueue({
            redisUrl: redisUrl as string,
        });
        const job = { schemaVersion: 1 as const, runId: runId(9) };
        try {
            await queue.ready();
            await expect(queue.enqueue(job)).resolves.toBe("enqueued");
            await expect(queue.enqueue(job)).resolves.toBe("duplicate");
        } finally {
            await queue.close();
        }
    });

    it("retains accepted work across an abandoned dispatcher claim and unavailable Redis", async () => {
        const registry = testRegistry();
        const store = createPostgresProcessRunStore({
            pool,
            retention: RETENTION,
        });
        const runs = createAsyncProcessRuns({ registry, store });
        const outbox = createPostgresProcessOutbox({ pool });
        const submitted = await runs.submit(
            {
                process: "test-success",
                version: "v1",
                input: { value: "recover-after-redis" },
            },
            { callerId: "caller-recovery", idempotencyKey: "redis-down" },
        );
        if (!submitted.accepted)
            throw new Error("Expected accepted Process Run");

        const claimedAt = new Date().toISOString();
        const abandoned = await outbox.claimProcessWork({
            limit: 1,
            claimToken: claimToken(1),
            claimedAt,
            claimExpiresAt: new Date(Date.now() + 50).toISOString(),
        });
        expect(abandoned).toHaveLength(1);
        await expect(
            outbox.claimProcessWork({
                limit: 1,
                claimToken: claimToken(2),
                claimedAt: new Date().toISOString(),
                claimExpiresAt: new Date(Date.now() + 50).toISOString(),
            }),
        ).resolves.toEqual([]);
        await delay(70);

        const unavailableQueue = createBullMqProcessWorkQueue({
            redisUrl: await unusedRedisUrl(),
            connectTimeoutMs: 50,
            onError: () => {},
        });
        try {
            const failedDispatcher = createOutboxDispatcher({
                outbox,
                queue: unavailableQueue,
            });
            await expect(failedDispatcher.dispatchOnce()).resolves.toEqual({
                claimed: 1,
                published: 0,
                failed: 1,
            });
        } finally {
            await unavailableQueue.close();
        }
        const pending = await pool.query<{
            published_at: Date | null;
            claim_token: string | null;
        }>("SELECT published_at, claim_token FROM outbox_messages");
        expect(pending.rows).toEqual([
            { published_at: null, claim_token: null },
        ]);

        const queue = createBullMqProcessWorkQueue({
            redisUrl: redisUrl as string,
        });
        const worker = runtimeWorker(registry, store);
        try {
            await queue.ready();
            await expect(
                createOutboxDispatcher({ outbox, queue }).dispatchOnce(),
            ).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
            await worker.start();
            await expect(
                waitForTerminal(runs, submitted.runId, "caller-recovery"),
            ).resolves.toMatchObject({
                status: "succeeded",
                output: { value: "completed:recover-after-redis" },
            });
        } finally {
            await Promise.allSettled([worker.close(), queue.close()]);
        }
    }, 20_000);

    it("dry-runs and rebuilds every nonterminal Run after Redis Queue data loss", async () => {
        const registry = testRegistry();
        const store = createPostgresProcessRunStore({
            pool,
            retention: RETENTION,
        });
        const recoveryStore = createPostgresProcessRunRecoverySource({ pool });
        const runs = createAsyncProcessRuns({ registry, store });
        const queue = createBullMqProcessWorkQueue({
            redisUrl: redisUrl as string,
        });
        const recoveryInspector = new Queue<ProcessWorkJob>(
            defaultProcessWorkQueueName,
            {
                connection: { url: redisUrl as string },
                prefix: defaultProcessWorkQueuePrefix,
            },
        );
        const outbox = createPostgresProcessOutbox({ pool });
        const completed = await runs.submit(
            {
                process: "test-success",
                version: "v1",
                input: { value: "already-terminal" },
            },
            { callerId: "caller-rebuild", idempotencyKey: "already-terminal" },
        );
        if (!completed.accepted)
            throw new Error("Expected accepted Process Run");
        const firstWorker = runtimeWorker(registry, store);

        try {
            await queue.ready();
            await createOutboxDispatcher({ outbox, queue }).dispatchOnce();
            await firstWorker.start();
            await expect(
                waitForTerminal(runs, completed.runId, "caller-rebuild"),
            ).resolves.toMatchObject({ status: "succeeded" });
            await firstWorker.close();

            const queued = [];
            for (const index of [1, 2, 3]) {
                const submission = await runs.submit(
                    {
                        process: "test-success",
                        version: "v1",
                        input: { value: `queue-loss-${index}` },
                    },
                    {
                        callerId: "caller-rebuild",
                        idempotencyKey: `queue-loss-${index}`,
                    },
                );
                if (!submission.accepted)
                    throw new Error("Expected accepted Process Run");
                queued.push(submission);
            }
            await expect(
                createOutboxDispatcher({
                    outbox,
                    queue,
                    batchSize: 2,
                }).dispatchOnce(),
            ).resolves.toEqual({ claimed: 2, published: 2, failed: 0 });
            expect(
                (
                    await queue.inspectJobs(queued.map((run) => run.runId))
                ).filter((job) => job.state === "runnable"),
            ).toHaveLength(2);

            await redis.flushdb();
            const firstQueuedRun = queued[0];
            if (!firstQueuedRun)
                throw new Error("Expected a queued Process Run");
            await recoveryInspector.add(
                "process-run",
                {
                    schemaVersion: 1,
                    runId: firstQueuedRun.runId,
                    input: "invalid-queue-content",
                } as unknown as ProcessWorkJob,
                { jobId: firstQueuedRun.runId },
            );
            await expect(
                queue.inspectJobs(queued.map((run) => run.runId)),
            ).resolves.toEqual(
                queued.map((run, index) => ({
                    runId: run.runId,
                    state: index === 0 ? "invalid" : "missing",
                })),
            );
            const asOf = new Date().toISOString();
            const dryRunReconciler = createProcessRunReconciler({
                store: recoveryStore,
                queue,
                batchSize: 100,
            });
            const dryRun = await dryRunReconciler.recover({
                trigger: "manual",
                mode: "all",
                dryRun: true,
                actorId: "operator:queue-rebuild-test",
                asOf,
            });
            expect(dryRun).toMatchObject({
                found: 3,
                missingJobs: 2,
                invalidJobs: 1,
                pendingOutbox: 1,
                enqueued: 0,
                outboxAcknowledged: 0,
            });
            expect(dryRun.items).toHaveLength(3);
            expect(
                dryRun.items.every((item) => item.action === "would_enqueue"),
            ).toBe(true);
            await expect(
                queue.inspectJobs(queued.map((run) => run.runId)),
            ).resolves.toEqual(
                queued.map((run, index) => ({
                    runId: run.runId,
                    state: index === 0 ? "invalid" : "missing",
                })),
            );

            const batchedReconciler = createProcessRunReconciler({
                store: recoveryStore,
                queue,
                batchSize: 2,
            });
            const repaired = [];
            let cursor: string | undefined;
            do {
                const report = await batchedReconciler.recover({
                    trigger: "manual",
                    mode: "all",
                    dryRun: false,
                    actorId: "operator:queue-rebuild-test",
                    asOf,
                    ...(cursor ? { cursor } : {}),
                });
                repaired.push(report);
                cursor = report.nextCursor;
            } while (cursor);
            expect(repaired).toHaveLength(2);
            expect(
                repaired.reduce((sum, report) => sum + report.enqueued, 0),
            ).toBe(3);
            expect(
                repaired.reduce(
                    (sum, report) => sum + report.outboxAcknowledged,
                    0,
                ),
            ).toBe(1);
            await expect(
                pool.query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM outbox_messages
          WHERE topic = 'process-runs' AND published_at IS NULL
        `),
            ).resolves.toMatchObject({ rows: [{ count: "0" }] });

            await expect(
                dryRunReconciler.recover({
                    trigger: "manual",
                    mode: "all",
                    dryRun: false,
                    actorId: "operator:queue-rebuild-test",
                    asOf,
                }),
            ).resolves.toMatchObject({
                found: 3,
                existingJobs: 3,
                enqueued: 0,
                duplicates: 0,
            });
            const recoveryWorker = runtimeWorker(registry, store);
            try {
                await recoveryWorker.start();
                await Promise.all(
                    queued.map((run) =>
                        waitForTerminal(runs, run.runId, "caller-rebuild"),
                    ),
                );
            } finally {
                await recoveryWorker.close();
            }
            const terminalAttempt = await pool.query<{
                attempt_count: number;
            }>("SELECT attempt_count FROM process_runs WHERE run_id = $1", [
                completed.runId,
            ]);
            expect(terminalAttempt.rows[0]?.attempt_count).toBe(1);
            const audit = await pool.query<{
                status: string;
                dry_run: boolean;
            }>("SELECT status, dry_run FROM queue_recovery_runs");
            expect(audit.rows).toHaveLength(4);
            expect(
                audit.rows.every((entry) => entry.status === "completed"),
            ).toBe(true);
            expect(audit.rows.filter((entry) => entry.dry_run)).toHaveLength(1);
            const auditItems = await pool.query<{ count: string }>(
                "SELECT count(*)::text AS count FROM queue_recovery_items",
            );
            expect(auditItems.rows[0]?.count).toBe("9");
            expect(
                await pool.query(
                    "SELECT 1 FROM queue_recovery_items WHERE run_id = $1",
                    [completed.runId],
                ),
            ).toMatchObject({ rowCount: 0 });
        } finally {
            await Promise.allSettled([
                firstWorker.close(),
                queue.close(),
                recoveryInspector.close(),
            ]);
        }
    }, 20_000);

    it("reconciles an expired claim after a duplicate job was already completed", async () => {
        const registry = testRegistry();
        const store = createPostgresProcessRunStore({
            pool,
            retention: RETENTION,
            claimLeaseMs: 2_000,
        });
        const recoveryStore = createPostgresProcessRunRecoverySource({ pool });
        const runs = createAsyncProcessRuns({ registry, store });
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
        const submitted = await runs.submit(
            {
                process: "test-success",
                version: "v1",
                input: { value: "lease-recovery" },
            },
            { callerId: "caller-lease", idempotencyKey: "lease-recovery" },
        );
        if (!submitted.accepted)
            throw new Error("Expected accepted Process Run");
        const staleToken = claimToken(3);
        const duplicateConsumer = createBullMqProcessWorker({
            redisUrl: redisUrl as string,
            worker: ignoredWorker,
            onError: () => {},
        });
        const recoveryWorker = runtimeWorker(registry, store);

        try {
            await queue.ready();
            await createOutboxDispatcher({
                outbox: createPostgresProcessOutbox({ pool }),
                queue,
            }).dispatchOnce();
            await store.claim({
                runId: submitted.runId,
                claimToken: staleToken,
                claimedAt: new Date().toISOString(),
            });
            await duplicateConsumer.start();
            await waitForJobState(inspector, submitted.runId, "completed");
            await duplicateConsumer.close();
            const reconciler = createProcessRunReconciler({
                store: recoveryStore,
                queue,
                queuedAgeMs: 1,
            });
            await expect(
                reconciler.recover({
                    trigger: "manual",
                    mode: "all",
                    dryRun: true,
                    actorId: "operator:lease-recovery-test",
                }),
            ).resolves.toMatchObject({
                found: 1,
                activeLeases: 1,
                enqueued: 0,
                items: [
                    expect.objectContaining({
                        queueState: "terminal",
                        action: "deferred",
                    }),
                ],
            });
            await delay(2_050);

            await expect(reconciler.reconcileOnce()).resolves.toEqual({
                found: 1,
                enqueued: 1,
                duplicates: 0,
                failed: 0,
            });
            await recoveryWorker.start();
            await expect(
                waitForTerminal(runs, submitted.runId, "caller-lease"),
            ).resolves.toMatchObject({
                status: "succeeded",
                output: { value: "completed:lease-recovery" },
            });
            await expect(
                store.complete({
                    runId: submitted.runId,
                    claimToken: staleToken,
                    completedAt: new Date().toISOString(),
                    completion: {
                        status: "succeeded",
                        output: { value: "stale" },
                    },
                }),
            ).resolves.toBe(false);
            const attempts = await pool.query<{
                attempt_number: number;
                status: string;
                result_code: string;
            }>(`
        SELECT attempt_number, status, result_code
        FROM process_run_attempts
        ORDER BY attempt_number
      `);
            expect(attempts.rows).toEqual([
                {
                    attempt_number: 1,
                    status: "abandoned",
                    result_code: "CLAIM_EXPIRED",
                },
                {
                    attempt_number: 2,
                    status: "succeeded",
                    result_code: "SUCCEEDED",
                },
            ]);
        } finally {
            await Promise.allSettled([
                duplicateConsumer.close(),
                recoveryWorker.close(),
                queue.close(),
                inspector.close(),
            ]);
        }
    }, 20_000);

    it("stops fetching and releases active claims when shutdown grace expires", async () => {
        let markStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const registration = defineProcessRegistration({
            id: "test-shutdown",
            version: "v1",
            inputSchema: z.strictObject({ value: z.string() }),
            outputSchema: z.strictObject({ value: z.string() }),
            execute: async (_input, context) => {
                markStarted?.();
                await new Promise<void>((resolve) =>
                    context.signal.addEventListener("abort", () => resolve(), {
                        once: true,
                    }),
                );
                return { value: "late" };
            },
        });
        const registry = createProcessRegistry([registration]);
        const store = createPostgresProcessRunStore({
            pool,
            retention: RETENTION,
            claimLeaseMs: 5_000,
        });
        const runs = createAsyncProcessRuns({ registry, store });
        const queue = createBullMqProcessWorkQueue({
            redisUrl: redisUrl as string,
        });
        const worker = createBullMqProcessWorker({
            redisUrl: redisUrl as string,
            worker: createProcessWorker({
                registry,
                store,
                attemptRunner: createProcessAttemptRunner({
                    processTimeoutMs: 5_000,
                }),
            }),
            shutdownGraceMs: 50,
            lockDurationMs: 250,
            stalledIntervalMs: 100,
            onError: () => {},
        });
        const submitted = await runs.submit(
            {
                process: "test-shutdown",
                version: "v1",
                input: { value: "shutdown" },
            },
            { callerId: "caller-shutdown", idempotencyKey: "shutdown" },
        );
        if (!submitted.accepted)
            throw new Error("Expected accepted Process Run");

        try {
            await queue.ready();
            await createOutboxDispatcher({
                outbox: createPostgresProcessOutbox({ pool }),
                queue,
            }).dispatchOnce();
            await worker.start();
            await started;
            const closeStartedAt = Date.now();
            await worker.close();
            expect(Date.now() - closeStartedAt).toBeLessThan(1_000);
            await expect(
                store.findOwned(submitted.runId, "caller-shutdown"),
            ).resolves.toMatchObject({ status: "queued", revision: 2 });
            const attempt = await pool.query<{
                status: string;
                result_code: string;
            }>("SELECT status, result_code FROM process_run_attempts");
            expect(attempt.rows).toEqual([
                { status: "abandoned", result_code: "CLAIM_RELEASED" },
            ]);
        } finally {
            await Promise.allSettled([worker.close(), queue.close()]);
        }
    }, 20_000);

    it("runs the authenticated async HTTP path through independent API, Dispatcher, and Worker roles", async () => {
        const businessApi = await startBusinessApi();
        const gatewaySecret = "integration-gateway-secret-at-least-32-bytes";
        const sharedEnvironment = {
            DATABASE_URL: databaseUrl,
            REDIS_URL: redisUrl,
            PROCESS_QUEUE_PREFIX: "pipipi-role-integration",
            PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS: "86400000",
            PROCESS_RUN_RESULT_RETENTION_MS: "604800000",
            PROCESS_RUN_METADATA_RETENTION_MS: "2592000000",
            PROCESS_TIMEOUT_MS: "2000",
            PROCESS_RUN_CLAIM_LEASE_MS: "5000",
            ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS: "500",
            ASYNC_REDIS_CONNECTION_TIMEOUT_MS: "500",
            RUNTIME_ROLE_READINESS_TIMEOUT_MS: "1000",
        } as const;
        const api = constructProcessingService({
            ...sharedEnvironment,
            BUSINESS_API_BASE_URL: businessApi.url,
            ASYNC_PROCESS_RUNS_ENABLED: "true",
            ASYNC_GATEWAY_SHARED_SECRET: gatewaySecret,
            ASYNC_RELEASE_STAGE: "internal",
            ASYNC_GLOBAL_BACKLOG_LIMIT: "1000",
            ASYNC_CALLER_BACKLOG_LIMIT: "100",
            ASYNC_BACKLOG_RETRY_AFTER_SECONDS: "5",
        });
        const dispatcher = constructProcessDispatcherService({
            DATABASE_URL: databaseUrl,
            REDIS_URL: redisUrl,
            PROCESS_QUEUE_PREFIX: sharedEnvironment.PROCESS_QUEUE_PREFIX,
            ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS: "500",
            ASYNC_REDIS_CONNECTION_TIMEOUT_MS: "500",
            RUNTIME_ROLE_READINESS_TIMEOUT_MS: "1000",
            OUTBOX_DISPATCH_INTERVAL_MS: "10",
            PROCESS_RUN_RECONCILE_INTERVAL_MS: "20",
            PROCESS_RUN_RECONCILE_QUEUED_AGE_MS: "20",
        });
        const worker = constructProcessWorkerService({
            ...sharedEnvironment,
            BUSINESS_API_BASE_URL: businessApi.url,
            BUSINESS_API_TIMEOUT_MS: "500",
            PROCESS_WORKER_CONCURRENCY: "2",
            PROCESS_WORKER_SHUTDOWN_GRACE_MS: "1000",
        });
        const applications = [
            api.application,
            dispatcher.application,
            worker.application,
        ];

        try {
            const [apiListening, dispatcherListening, workerListening] =
                await Promise.all(
                    applications.map((application) => application.listen()),
                );
            if (!apiListening || !dispatcherListening || !workerListening) {
                throw new Error("Expected all runtime roles to listen");
            }
            for (const url of [
                apiListening.url,
                dispatcherListening.url,
                workerListening.url,
            ]) {
                await expect(
                    waitForHttpStatus(`${url}/healthz`, 200),
                ).resolves.toBe(200);
                await expect(
                    waitForHttpStatus(`${url}/readyz`, 200),
                ).resolves.toBe(200);
            }

            const callerHeaders = {
                "content-type": "application/json",
                [callerIdentityHeader]: "service:role-integration",
                [gatewayAuthenticationHeader]: gatewaySecret,
            };
            const successResponse = await fetch(
                `${apiListening.url}/process-runs`,
                {
                    method: "POST",
                    headers: {
                        ...callerHeaders,
                        "idempotency-key": "role-success",
                    },
                    body: JSON.stringify({
                        process: "content-processing",
                        version: "v1",
                        input: { content: "role success" },
                    }),
                },
            );
            const failureResponse = await fetch(
                `${apiListening.url}/process-runs`,
                {
                    method: "POST",
                    headers: {
                        ...callerHeaders,
                        "idempotency-key": "role-failure",
                    },
                    body: JSON.stringify({
                        process: "content-processing",
                        version: "v1",
                        input: { content: "fail-dependency" },
                    }),
                },
            );
            const success = (await successResponse.json()) as { runId: string };
            const failure = (await failureResponse.json()) as { runId: string };
            expect(successResponse.status).toBe(202);
            expect(failureResponse.status).toBe(202);

            await expect(
                waitForHttpRun(apiListening.url, success.runId, {
                    [callerIdentityHeader]: "service:role-integration",
                    [gatewayAuthenticationHeader]: gatewaySecret,
                }),
            ).resolves.toMatchObject({
                status: "succeeded",
                output: { content: "Processed: role success" },
            });
            await expect(
                waitForHttpRun(apiListening.url, failure.runId, {
                    [callerIdentityHeader]: "service:role-integration",
                    [gatewayAuthenticationHeader]: gatewaySecret,
                }),
            ).resolves.toMatchObject({
                status: "failed",
                error: {
                    code: "DEPENDENCY_FAILURE",
                    message: "A required business service is unavailable",
                },
            });

            const isolated = await fetch(
                `${apiListening.url}/process-runs/${success.runId}`,
                {
                    headers: {
                        [callerIdentityHeader]: "service:other-caller",
                        [gatewayAuthenticationHeader]: gatewaySecret,
                    },
                },
            );
            expect(isolated.status).toBe(404);

            const synchronous = await fetch(`${apiListening.url}/execute`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    process: "content-processing",
                    version: "v1",
                    input: { content: "sync remains enabled" },
                }),
            });
            expect(synchronous.status).toBe(200);
            expect(await synchronous.json()).toMatchObject({
                status: "succeeded",
                output: { content: "Processed: sync remains enabled" },
            });
        } finally {
            await Promise.allSettled(
                applications.map((application) => application.close()),
            );
            await businessApi.close();
        }
    }, 20_000);
});

const ignoredWorker: ProcessWorker = {
    process: async () => "ignored",
    releaseActive: async () => 0,
};

function runtimeWorker(
    registry: ReturnType<typeof testRegistry>,
    store: ReturnType<typeof createPostgresProcessRunStore>,
) {
    return createBullMqProcessWorker({
        redisUrl: redisUrl as string,
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

function testRegistry() {
    const inputSchema = z.strictObject({ value: z.string() });
    const outputSchema = z.strictObject({ value: z.string() });
    return createProcessRegistry([
        defineProcessRegistration({
            id: "test-success",
            version: "v1",
            inputSchema,
            outputSchema,
            execute: async (input) => ({ value: `completed:${input.value}` }),
        }),
        defineProcessRegistration({
            id: "test-failure",
            version: "v2",
            inputSchema,
            outputSchema,
            execute: async () =>
                failProcess(
                    "DEPENDENCY_FAILURE",
                    "The test dependency is unavailable",
                ),
        }),
    ]);
}

async function waitForTerminal(
    runs: ReturnType<typeof createAsyncProcessRuns>,
    runIdValue: string,
    callerId: string,
): Promise<ProcessRunView> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const run = await runs.find(runIdValue, { callerId });
        if (run?.status === "succeeded" || run?.status === "failed") return run;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Process Run ${runIdValue} did not reach a terminal state`);
}

async function waitForStoredRun(
    store: ReturnType<typeof createPostgresProcessRunStore>,
    runIdValue: string,
    callerId: string,
    predicate: (
        run: NonNullable<Awaited<ReturnType<typeof store.findOwned>>>,
    ) => boolean,
) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const run = await store.findOwned(runIdValue, callerId);
        if (run && predicate(run)) return run;
        await delay(20);
    }
    throw new Error(
        `Process Run ${runIdValue} did not reach the expected state`,
    );
}

async function waitForSuccessfulDeliveries(
    store: ReturnType<typeof createPostgresWebhookDeliveryStore>,
    runIds: readonly string[],
): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const deliveries = await store.findByRun({
            ownerId: "caller-webhook",
            runIds,
        });
        if (
            deliveries.length === runIds.length &&
            deliveries.every((delivery) => delivery.status === "succeeded")
        ) {
            return;
        }
        await delay(20);
    }
    throw new Error("Webhook Deliveries did not succeed");
}

async function listenHttpServer(server: Server): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Expected address");
    return `http://127.0.0.1:${address.port}`;
}

async function waitForJobState(
    queue: Queue<ProcessWorkJob>,
    jobId: string,
    expectedState: string,
): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const job = await queue.getJob(jobId);
        if (job && (await job.getState()) === expectedState) return;
        await delay(20);
    }
    throw new Error(`Queue Job ${jobId} did not reach ${expectedState}`);
}

async function unusedRedisUrl(): Promise<string> {
    const server = createTcpServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP port");
    }
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return `redis://127.0.0.1:${address.port}/15`;
}

async function startBusinessApi(): Promise<{
    url: string;
    close: () => Promise<void>;
}> {
    const server = createHttpServer((request, response) => {
        void handleBusinessRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected the Business API to listen on an IP address");
    }
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => closeHttpServer(server),
    };
}

async function handleBusinessRequest(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
): Promise<void> {
    if (request.method !== "POST" || request.url !== "/process") {
        response.writeHead(404).end();
        return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        content: string;
    };
    if (body.content === "fail-dependency") {
        response.writeHead(503).end();
        return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ content: `Processed: ${body.content}` }));
}

async function closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}

async function waitForHttpStatus(url: string, status: number): Promise<number> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const response = await fetch(url);
        if (response.status === status) return response.status;
        await delay(20);
    }
    throw new Error(`${url} did not return ${status}`);
}

async function waitForHttpRun(
    baseUrl: string,
    runIdValue: string,
    headers: Record<string, string>,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}/process-runs/${runIdValue}`, {
            headers,
        });
        if (response.status === 200) {
            const body = (await response.json()) as Record<string, unknown>;
            if (body.status === "succeeded" || body.status === "failed")
                return body;
        }
        await delay(20);
    }
    throw new Error(`Process Run ${runIdValue} did not reach a terminal state`);
}

function delay(milliseconds: number): Promise<void> {
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

function assertTestDatabase(url: string): void {
    if (!new URL(url).pathname.slice(1).endsWith("_test")) {
        throw new Error(
            "Async integration tests require a database name ending in _test",
        );
    }
}

function assertTestRedis(urlValue: string): void {
    const url = new URL(urlValue);
    const database = Number(url.pathname.slice(1));
    if (
        url.protocol !== "redis:" ||
        (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
        !Number.isInteger(database) ||
        database < 1
    ) {
        throw new Error(
            "Async integration tests require a local redis:// URL with a non-zero database",
        );
    }
}

function runId(index: number): string {
    return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function claimToken(index: number): string {
    return `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

const RETENTION = {
    acceptedInputMs: 86_400_000,
    resultMs: 604_800_000,
    metadataMs: 2_592_000_000,
} as const;
