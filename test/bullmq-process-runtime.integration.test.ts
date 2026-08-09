import path from "node:path";
import { createServer } from "node:net";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAsyncProcessRuns, type ProcessRunView } from "../src/async-process-runs.js";
import {
  createBullMqProcessWorker,
  createBullMqProcessWorkQueue,
  defaultProcessWorkQueueName,
  defaultProcessWorkQueuePrefix,
} from "../src/bullmq-process-work-queue.js";
import { createOutboxDispatcher } from "../src/outbox-dispatcher.js";
import { createPostgresProcessOutbox } from "../src/postgres-process-outbox.js";
import { createPostgresProcessRunStore } from "../src/postgres-process-run-store.js";
import { createProcessRunReconciler } from "../src/process-run-reconciler.js";
import {
  createProcessAttemptRunner,
  createProcessRegistry,
  defineProcessRegistration,
  failProcess,
} from "../src/process-runtime.js";
import { createProcessWorker } from "../src/process-worker.js";
import type { ProcessWorker } from "../src/process-worker.js";
import type { ProcessWorkJob } from "../src/process-work-queue.js";
import { z } from "zod";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_TEST_URL;
if (
  process.env.RUN_ASYNC_INTEGRATION === "1" &&
  (!databaseUrl || !redisUrl)
) {
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
    await pool.query("TRUNCATE process_runs CASCADE");
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
    const queue = createBullMqProcessWorkQueue({ redisUrl: redisUrl as string });
    const dispatcher = createOutboxDispatcher({
      outbox: createPostgresProcessOutbox({ pool }),
      queue,
    });
    const worker = createBullMqProcessWorker({
      redisUrl: redisUrl as string,
      worker: createProcessWorker({
        registry,
        store,
        attemptRunner: createProcessAttemptRunner({ processTimeoutMs: 5_000 }),
      }),
    });
    const inspector = new Queue<ProcessWorkJob>(defaultProcessWorkQueueName, {
      connection: { url: redisUrl as string },
      prefix: defaultProcessWorkQueuePrefix,
    });

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
      expect(persistence.rows[0]).toEqual({ published: "2", attempts: "2" });
    } finally {
      await Promise.allSettled([
        worker.close(),
        queue.close(),
        inspector.close(),
      ]);
    }
  }, 20_000);

  it("deduplicates a repeated outbox publication by runId", async () => {
    const queue = createBullMqProcessWorkQueue({ redisUrl: redisUrl as string });
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
    const store = createPostgresProcessRunStore({ pool, retention: RETENTION });
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
    if (!submitted.accepted) throw new Error("Expected accepted Process Run");

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
    expect(pending.rows).toEqual([{ published_at: null, claim_token: null }]);

    const queue = createBullMqProcessWorkQueue({ redisUrl: redisUrl as string });
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

  it("reconciles an expired claim after a duplicate job was already completed", async () => {
    const registry = testRegistry();
    const store = createPostgresProcessRunStore({
      pool,
      retention: RETENTION,
      claimLeaseMs: 75,
    });
    const runs = createAsyncProcessRuns({ registry, store });
    const queue = createBullMqProcessWorkQueue({ redisUrl: redisUrl as string });
    const inspector = new Queue<ProcessWorkJob>(defaultProcessWorkQueueName, {
      connection: { url: redisUrl as string },
      prefix: defaultProcessWorkQueuePrefix,
    });
    const submitted = await runs.submit(
      {
        process: "test-success",
        version: "v1",
        input: { value: "lease-recovery" },
      },
      { callerId: "caller-lease", idempotencyKey: "lease-recovery" },
    );
    if (!submitted.accepted) throw new Error("Expected accepted Process Run");
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
      await delay(100);

      await expect(
        createProcessRunReconciler({
          store,
          queue,
          queuedAgeMs: 1,
        }).reconcileOnce(),
      ).resolves.toEqual({
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
          completion: { status: "succeeded", output: { value: "stale" } },
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
        { attempt_number: 1, status: "abandoned", result_code: "CLAIM_EXPIRED" },
        { attempt_number: 2, status: "succeeded", result_code: "SUCCEEDED" },
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
    const queue = createBullMqProcessWorkQueue({ redisUrl: redisUrl as string });
    const worker = createBullMqProcessWorker({
      redisUrl: redisUrl as string,
      worker: createProcessWorker({
        registry,
        store,
        attemptRunner: createProcessAttemptRunner({ processTimeoutMs: 5_000 }),
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
    if (!submitted.accepted) throw new Error("Expected accepted Process Run");

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
      attemptRunner: createProcessAttemptRunner({ processTimeoutMs: 5_000 }),
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
  const server = createServer();
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
