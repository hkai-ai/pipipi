import path from "node:path";
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
import {
  createProcessAttemptRunner,
  createProcessRegistry,
  defineProcessRegistration,
  failProcess,
} from "../src/process-runtime.js";
import { createProcessWorker } from "../src/process-worker.js";
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
});

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

const RETENTION = {
  acceptedInputMs: 86_400_000,
  resultMs: 604_800_000,
  metadataMs: 2_592_000_000,
} as const;
