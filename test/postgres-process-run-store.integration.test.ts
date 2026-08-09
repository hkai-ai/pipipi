import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { createAsyncProcessRuns } from "../src/async-process-runs.js";
import {
  createPostgresAsyncOperations,
  createPostgresAsyncReleaseReadiness,
} from "../src/async-operations.js";
import {
  callerIdentityHeader,
  gatewayAuthenticationHeader,
} from "../src/caller-identity.js";
import { createPostgresProcessRunStore } from "../src/postgres-process-run-store.js";
import { createPostgresRetentionCleanup } from "../src/postgres-retention-cleanup.js";
import { createPostgresWebhookDeliveryStore } from "../src/postgres-webhook-delivery-store.js";
import { createWebhookSecretCipher } from "../src/webhook-secret-cipher.js";
import { createWebhookTargetPolicy } from "../src/webhook-target-policy.js";
import {
  createStandardWebhookHttpSender,
  createWebhookDeliveryWorker,
} from "../src/webhook-delivery.js";
import {
  ProcessRunBacklogLimitError,
  type ProcessRunStore,
} from "../src/process-run-store.js";
import { createProcessRegistry } from "../src/process-runtime.js";
import { constructProcessingService } from "../src/startup-construction.js";
import { processRunStoreContract } from "./support/process-run-store-contract.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
if (process.env.RUN_POSTGRES_INTEGRATION === "1" && !databaseUrl) {
  throw new Error(
    "POSTGRES_TEST_DATABASE_URL is required for PostgreSQL integration tests",
  );
}

const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;

postgresDescribe("PostgreSQL Process Run Store", () => {
  let primaryPool: Pool;
  let secondaryPool: Pool;
  let primaryStore: ProcessRunStore;
  let secondaryStore: ProcessRunStore;
  let secondMigrationRunCount = -1;

  beforeAll(async () => {
    assertTestDatabase(databaseUrl as string);
    primaryPool = new Pool({ connectionString: databaseUrl, max: 4 });
    secondaryPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await primaryPool.query("DROP SCHEMA public CASCADE");
    await primaryPool.query("CREATE SCHEMA public");
    await migrate(databaseUrl as string);
    secondMigrationRunCount = (await migrate(databaseUrl as string)).length;
    primaryStore = postgresStore(primaryPool);
    secondaryStore = postgresStore(secondaryPool);
  }, 30_000);

  beforeEach(async () => {
    await primaryPool.query(
      "TRUNCATE queue_recovery_runs, retention_cleanup_batches, webhook_endpoints, process_runs CASCADE",
    );
  });

  afterAll(async () => {
    await Promise.all([primaryPool?.end(), secondaryPool?.end()]);
  });

  it("applies the migration once and detects the applied version", () => {
    expect(secondMigrationRunCount).toBe(0);
  });

  processRunStoreContract("PostgreSQL", () => primaryStore);

  it("persists a terminal result across independent adapter instances", async () => {
    const run = acceptedRun(10, {
      ownerId: "caller-cross-instance",
      idempotencyKey: "cross-instance",
    });
    await primaryStore.accept(run);

    await expect(
      secondaryStore.findOwned(run.runId, run.ownerId),
    ).resolves.toMatchObject({ status: "queued", runId: run.runId });
    const claim = await secondaryStore.claim({
      runId: run.runId,
      claimToken: claimToken(10),
      claimedAt: "2026-08-09T10:00:01.000Z",
    });
    if (!claim) throw new Error("Expected Process Run claim");
    await secondaryStore.complete({
      runId: run.runId,
      claimToken: claim.claimToken,
      completedAt: "2026-08-09T10:00:02.000Z",
      completion: { status: "succeeded", output: { value: "persisted" } },
    });

    await expect(
      primaryStore.findOwned(run.runId, run.ownerId),
    ).resolves.toMatchObject({
      status: "succeeded",
      output: { value: "persisted" },
    });
  });

  it("admits idempotent replay before enforcing caller and global backlog limits", async () => {
    const store = createPostgresProcessRunStore({
      pool: primaryPool,
      retention: RETENTION,
      admission: {
        globalBacklogLimit: 2,
        callerBacklogLimit: 1,
        retryAfterSeconds: 7,
      },
    });
    const first = acceptedRun(201, {
      ownerId: "caller-admission-a",
      idempotencyKey: "first",
    });
    await expect(store.accept(first)).resolves.toMatchObject({ outcome: "created" });
    await expect(store.accept(first)).resolves.toMatchObject({ outcome: "replayed" });

    await expect(
      store.accept(
        acceptedRun(202, {
          ownerId: "caller-admission-a",
          idempotencyKey: "second",
        }),
      ),
    ).rejects.toEqual(new ProcessRunBacklogLimitError("caller", 7));

    const secondCaller = acceptedRun(203, {
      ownerId: "caller-admission-b",
      idempotencyKey: "first",
    });
    await expect(store.accept(secondCaller)).resolves.toMatchObject({
      outcome: "created",
    });
    await expect(
      store.accept(
        acceptedRun(204, {
          ownerId: "caller-admission-c",
          idempotencyKey: "first",
        }),
      ),
    ).rejects.toEqual(new ProcessRunBacklogLimitError("global", 7));

    await expect(store.findOwned(first.runId, first.ownerId)).resolves.toMatchObject({
      runId: first.runId,
      status: "queued",
    });
  });

  it("serializes concurrent acceptance so the global backlog cannot overshoot", async () => {
    const stores = [primaryPool, secondaryPool].map((pool) =>
      createPostgresProcessRunStore({
        pool,
        retention: RETENTION,
        admission: {
          globalBacklogLimit: 3,
          callerBacklogLimit: 3,
          retryAfterSeconds: 5,
        },
      }),
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        stores[index % stores.length]!.accept(
          acceptedRun(220 + index, {
            ownerId: `caller-concurrent-${index}`,
            idempotencyKey: `concurrent-${index}`,
          }),
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(9);
    expect(
      rejected.every(
        (outcome) =>
          outcome.reason instanceof ProcessRunBacklogLimitError &&
          outcome.reason.scope === "global",
      ),
    ).toBe(true);
    const count = await primaryPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM process_runs WHERE status IN ('queued', 'running')",
    );
    expect(count.rows[0]?.count).toBe("3");
  });

  it("reports Run, Outbox, Webhook, cleanup, recovery, and storage operations metrics", async () => {
    const queued = acceptedRun(240, {
      ownerId: "caller-observe-a",
      idempotencyKey: "queued",
    });
    const failed = acceptedRun(241, {
      ownerId: "caller-observe-b",
      idempotencyKey: "failed",
    });
    await primaryStore.accept(queued);
    await primaryStore.accept(failed);
    const claim = await primaryStore.claim({
      runId: failed.runId,
      claimToken: claimToken(241),
      claimedAt: "2026-08-09T10:00:02.000Z",
    });
    if (!claim) throw new Error("Expected Process Run claim");
    await primaryStore.complete({
      runId: failed.runId,
      claimToken: claim.claimToken,
      completedAt: "2026-08-09T10:00:12.000Z",
      completion: {
        status: "failed",
        error: { code: "INTERNAL_ERROR", message: "Public failure" },
      },
    });

    const futureWebhookOutbox = await primaryPool.query(
      `
        INSERT INTO outbox_messages (
          message_id,
          event_id,
          topic,
          payload,
          created_at,
          available_at
        )
        SELECT
          '50000000-0000-4000-8000-000000000240',
          event_id,
          'webhook-deliveries',
          '{"schemaVersion":1,"deliveryId":"50000000-0000-4000-8000-000000000241"}'::jsonb,
          '2026-08-09T10:00:30.000Z',
          '2026-08-09T10:02:00.000Z'
        FROM process_events
        ORDER BY created_at, event_id
        LIMIT 1
      `,
    );
    expect(futureWebhookOutbox.rowCount).toBe(1);

    const operations = createPostgresAsyncOperations({
      pool: primaryPool,
      recentWindowMs: 120_000,
      stuckRunAgeMs: 30_000,
    });
    await expect(operations.ready()).resolves.toBeUndefined();
    const snapshot = await operations.snapshot({
      asOf: "2026-08-09T10:01:00.000Z",
    });

    expect(snapshot.runs).toMatchObject({
      queued: 1,
      running: 0,
      succeededRecent: 0,
      failedRecent: 1,
      failureRateRecent: 1,
      oldestQueuedAgeMs: 60_000,
      queueWaitP95Ms: 2_000,
      executionP95Ms: 10_000,
      stuck: 1,
    });
    expect(snapshot.outbox).toMatchObject({
      processPending: 2,
      webhookPending: 0,
      oldestProcessLagMs: 60_000,
      oldestWebhookLagMs: 0,
    });
    expect(snapshot.webhooks).toMatchObject({
      pending: 0,
      delivering: 0,
      succeededRecent: 0,
      failedRecent: 0,
      exhaustedRecent: 0,
    });
    expect(snapshot.storage.databaseBytes).toBeGreaterThan(0);
    expect(snapshot.storage.asyncTablesBytes).toBeGreaterThan(0);

    await primaryPool.query(
      `
        INSERT INTO queue_recovery_runs (
          recovery_id,
          trigger_kind,
          recovery_mode,
          dry_run,
          actor_id,
          as_of,
          queued_before,
          status,
          started_at,
          completed_at
        )
        VALUES (
          '40000000-0000-4000-8000-000000000240',
          'manual',
          'all',
          true,
          'operator:release-gate-test',
          '2026-08-09T10:00:50.000Z',
          '2026-08-09T10:00:20.000Z',
          'completed',
          '2026-08-09T10:00:50.000Z',
          '2026-08-09T10:00:51.000Z'
        )
      `,
    );
    const releaseReady = createPostgresAsyncReleaseReadiness({
      pool: primaryPool,
      stage: "canary",
      globalBacklogLimit: 100,
      stuckRunAgeMs: 120_000,
      maximumStuckRuns: 0,
      maximumOutboxLagMs: 120_000,
      recoveryMaxAgeMs: 120_000,
      clock: () => "2026-08-09T10:01:00.000Z",
    });
    await expect(releaseReady()).resolves.toBeUndefined();

    await primaryPool.query(
      `
        INSERT INTO queue_recovery_runs (
          recovery_id,
          trigger_kind,
          recovery_mode,
          dry_run,
          actor_id,
          as_of,
          queued_before,
          next_cursor_run_id,
          status,
          started_at,
          completed_at
        )
        VALUES (
          '40000000-0000-4000-8000-000000000242',
          'manual',
          'all',
          true,
          'operator:multi-batch-gate-test',
          '2026-08-09T10:00:52.000Z',
          '2026-08-09T10:00:22.000Z',
          '40000000-0000-4000-8000-000000000299',
          'completed',
          '2026-08-09T10:00:52.000Z',
          '2026-08-09T10:00:53.000Z'
        )
      `,
    );
    await expect(releaseReady()).rejects.toThrow("recovery gate");

    await primaryPool.query(
      `
        INSERT INTO queue_recovery_runs (
          recovery_id,
          trigger_kind,
          recovery_mode,
          dry_run,
          actor_id,
          as_of,
          queued_before,
          cursor_run_id,
          status,
          started_at,
          completed_at
        )
        VALUES (
          '40000000-0000-4000-8000-000000000243',
          'manual',
          'all',
          true,
          'operator:multi-batch-gate-test',
          '2026-08-09T10:00:52.000Z',
          '2026-08-09T10:00:22.000Z',
          '40000000-0000-4000-8000-000000000299',
          'completed',
          '2026-08-09T10:00:54.000Z',
          '2026-08-09T10:00:55.000Z'
        )
      `,
    );
    await expect(releaseReady()).resolves.toBeUndefined();

    await primaryPool.query(
      `
        INSERT INTO queue_recovery_runs (
          recovery_id,
          trigger_kind,
          recovery_mode,
          dry_run,
          actor_id,
          as_of,
          queued_before,
          cursor_run_id,
          status,
          error_code,
          started_at,
          completed_at
        )
        VALUES (
          '40000000-0000-4000-8000-000000000244',
          'manual',
          'all',
          true,
          'operator:multi-batch-gate-test',
          '2026-08-09T10:00:52.000Z',
          '2026-08-09T10:00:22.000Z',
          '40000000-0000-4000-8000-000000000299',
          'failed',
          'RECOVERY_FAILED',
          '2026-08-09T10:00:56.000Z',
          '2026-08-09T10:00:57.000Z'
        )
      `,
    );
    await expect(releaseReady()).rejects.toThrow("recovery gate");
  });

  it("persists a stable failure across independent adapter instances", async () => {
    const run = acceptedRun(11, {
      ownerId: "caller-failure",
      idempotencyKey: "failure",
    });
    await primaryStore.accept(run);
    const claim = await primaryStore.claim({
      runId: run.runId,
      claimToken: claimToken(11),
      claimedAt: "2026-08-09T10:00:01.000Z",
    });
    if (!claim) throw new Error("Expected Process Run claim");
    await primaryStore.complete({
      runId: run.runId,
      claimToken: claim.claimToken,
      completedAt: "2026-08-09T10:00:02.000Z",
      completion: {
        status: "failed",
        error: {
          code: "DEPENDENCY_FAILURE",
          message: "The dependency is unavailable",
        },
      },
    });

    await expect(
      secondaryStore.findOwned(run.runId, run.ownerId),
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "DEPENDENCY_FAILURE",
        message: "The dependency is unavailable",
      },
    });
  });

  it("serializes concurrent idempotent acceptance into one run and outbox", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      acceptedRun(20 + index, {
        ownerId: "caller-concurrent",
        idempotencyKey: "same-key",
      }),
    );

    const results = await Promise.all(
      candidates.map((candidate) => primaryStore.accept(candidate)),
    );
    const created = results.filter((result) => result.outcome === "created");
    const replayed = results.filter((result) => result.outcome === "replayed");
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(11);
    const runIds = new Set(
      results.flatMap((result) =>
        result.outcome === "conflict" ? [] : [result.run.runId],
      ),
    );
    expect(runIds.size).toBe(1);

    const counts = await primaryPool.query<{
      runs: string;
      events: string;
      messages: string;
    }>(`
      SELECT
        (SELECT count(*) FROM process_runs)::text AS runs,
        (SELECT count(*) FROM process_events)::text AS events,
        (SELECT count(*) FROM outbox_messages)::text AS messages
    `);
    expect(counts.rows[0]).toEqual({ runs: "1", events: "1", messages: "1" });
  });

  it("rolls back the run and event when the outbox write fails", async () => {
    const duplicateMessageId = "30000000-0000-4000-8000-000000000001";
    const failingStore = createPostgresProcessRunStore({
      pool: primaryPool,
      retention: RETENTION,
      createOutboxMessageId: () => duplicateMessageId,
    });
    const first = acceptedRun(40, {
      ownerId: "caller-rollback",
      idempotencyKey: "first",
    });
    const rolledBack = acceptedRun(41, {
      ownerId: "caller-rollback",
      idempotencyKey: "second",
    });
    await failingStore.accept(first);

    await expect(failingStore.accept(rolledBack)).rejects.toMatchObject({
      code: "23505",
    });
    await expect(
      primaryStore.findOwned(rolledBack.runId, rolledBack.ownerId),
    ).resolves.toBeUndefined();
    const counts = await primaryPool.query<{
      runs: string;
      events: string;
      messages: string;
    }>(`
      SELECT
        (SELECT count(*) FROM process_runs)::text AS runs,
        (SELECT count(*) FROM process_events)::text AS events,
        (SELECT count(*) FROM outbox_messages)::text AS messages
    `);
    expect(counts.rows[0]).toEqual({ runs: "1", events: "1", messages: "1" });
  });

  it("writes only the minimal queue envelope to the outbox", async () => {
    const run = acceptedRun(50, {
      ownerId: "caller-outbox",
      idempotencyKey: "outbox",
      inputValue: "sensitive business input",
    });
    await primaryStore.accept(run);

    const outbox = await primaryPool.query<{
      topic: string;
      payload: unknown;
    }>("SELECT topic, payload FROM outbox_messages");
    expect(outbox.rows).toEqual([
      {
        topic: "process-runs",
        payload: { schemaVersion: 1, runId: run.runId },
      },
    ]);
    expect(JSON.stringify(outbox.rows)).not.toContain("sensitive business input");
  });

  it("atomically creates thin terminal Webhook Deliveries and persists a 2xx result", async () => {
    const webhooks = postgresWebhookStore(primaryPool);
    await webhooks.provisionEndpoint({
      endpointId: "20000000-0000-4000-8000-000000000001",
      ownerId: "caller-webhook",
      actorId: "operator:test",
      url: "https://hooks.example/process-runs",
      secret: `whsec_${Buffer.alloc(32, 5).toString("base64")}`,
      createdAt: "2026-08-09T10:00:00.000Z",
    });
    const succeeded = acceptedRun(51, {
      ownerId: "caller-webhook",
      idempotencyKey: "webhook-success",
      inputValue: "sensitive-success-input",
    });
    const failed = acceptedRun(52, {
      ownerId: "caller-webhook",
      idempotencyKey: "webhook-failure",
      inputValue: "sensitive-failure-input",
    });
    await primaryStore.accept(succeeded);
    await primaryStore.accept(failed);
    const successClaim = await primaryStore.claim({
      runId: succeeded.runId,
      claimToken: claimToken(51),
      claimedAt: "2026-08-09T10:00:01.000Z",
    });
    const failureClaim = await primaryStore.claim({
      runId: failed.runId,
      claimToken: claimToken(52),
      claimedAt: "2026-08-09T10:00:01.000Z",
    });
    if (!successClaim || !failureClaim) throw new Error("Expected claims");
    await primaryStore.complete({
      runId: succeeded.runId,
      claimToken: successClaim.claimToken,
      completedAt: "2026-08-09T10:00:02.000Z",
      completion: {
        status: "succeeded",
        output: { content: "sensitive-success-output" },
      },
    });
    await primaryStore.complete({
      runId: failed.runId,
      claimToken: failureClaim.claimToken,
      completedAt: "2026-08-09T10:00:03.000Z",
      completion: {
        status: "failed",
        error: { code: "DEPENDENCY_FAILURE", message: "Stable public failure" },
      },
    });

    const deliveries = await webhooks.findByRun({
      ownerId: "caller-webhook",
      runIds: [succeeded.runId, failed.runId],
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((delivery) => delivery.eventType).sort()).toEqual([
      "process_run.failed",
      "process_run.succeeded",
    ]);
    const persisted = await primaryPool.query<{
      delivery_id: string;
      payload: string;
      topic: string;
      outbox_payload: unknown;
    }>(`
      SELECT
        deliveries.delivery_id,
        deliveries.payload,
        messages.topic,
        messages.payload AS outbox_payload
      FROM webhook_deliveries AS deliveries
      JOIN outbox_messages AS messages
        ON messages.payload->>'deliveryId' = deliveries.delivery_id::text
      ORDER BY deliveries.created_at
    `);
    expect(persisted.rows).toHaveLength(2);
    for (const row of persisted.rows) {
      expect(row.topic).toBe("webhook-deliveries");
      expect(row.outbox_payload).toEqual({
        schemaVersion: 1,
        deliveryId: row.delivery_id,
      });
      expect(row.payload).toContain('"resultLocation":"/process-runs/');
      expect(row.payload).not.toContain("sensitive-");
      expect(row.payload).not.toContain("output");
    }

    const delivery = deliveries[0];
    if (!delivery) throw new Error("Expected Delivery");
    const claim = await webhooks.claim({
      deliveryId: delivery.deliveryId,
      claimToken: "30000000-0000-4000-8000-000000000001",
      claimedAt: "2026-08-09T10:00:04.000Z",
    });
    expect(claim).toMatchObject({
      deliveryId: delivery.deliveryId,
      endpointUrl: "https://hooks.example/process-runs",
      attemptNumber: 1,
    });
    await expect(
      webhooks.complete({
        deliveryId: delivery.deliveryId,
        claimToken: "30000000-0000-4000-8000-000000000001",
        completedAt: "2026-08-09T10:00:05.000Z",
        result: { outcome: "succeeded", httpStatus: 204, latencyMs: 12 },
      }),
    ).resolves.toBe(true);
    await expect(
      webhooks.findByRun({
        ownerId: "caller-webhook",
        runIds: [delivery.runId],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        deliveryId: delivery.deliveryId,
        status: "succeeded",
        attemptCount: 1,
        lastHttpStatus: 204,
      }),
    ]);
  });

  it("audits every Webhook Attempt and replays an exhausted Delivery without rewriting history", async () => {
    const webhooks = postgresWebhookStore(primaryPool);
    const endpointId = "20000000-0000-4000-8000-000000000019";
    await webhooks.provisionEndpoint({
      endpointId,
      ownerId: "caller-webhook-retry",
      actorId: "operator:test",
      url: "https://hooks.example/retry",
      secret: `whsec_${Buffer.alloc(32, 19).toString("base64")}`,
      createdAt: "2026-08-09T10:00:00.000Z",
    });
    const run = acceptedRun(53, {
      ownerId: "caller-webhook-retry",
      idempotencyKey: "webhook-retry-replay",
    });
    await primaryStore.accept(run);
    const runClaim = await primaryStore.claim({
      runId: run.runId,
      claimToken: claimToken(53),
      claimedAt: "2026-08-09T10:00:01.000Z",
    });
    if (!runClaim) throw new Error("Expected Process Run claim");
    await primaryStore.complete({
      runId: run.runId,
      claimToken: runClaim.claimToken,
      completedAt: "2026-08-09T10:00:02.000Z",
      completion: { status: "succeeded", output: { value: "not-in-webhook" } },
    });
    const [delivery] = await webhooks.findByRun({
      ownerId: run.ownerId,
      runIds: [run.runId],
    });
    if (!delivery) throw new Error("Expected Webhook Delivery");

    const firstClaimToken = "30000000-0000-4000-8000-000000000019";
    await expect(
      webhooks.claim({
        deliveryId: delivery.deliveryId,
        claimToken: firstClaimToken,
        claimedAt: "2026-08-09T10:00:03.000Z",
      }),
    ).resolves.toMatchObject({ attemptNumber: 1 });
    await expect(
      webhooks.findAttempts({
        ownerId: run.ownerId,
        deliveryId: delivery.deliveryId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        eventId: delivery.eventId,
        runId: run.runId,
        endpointId,
        attemptNumber: 1,
        outcome: "started",
      }),
    ]);
    await expect(
      webhooks.reschedule({
        deliveryId: delivery.deliveryId,
        claimToken: firstClaimToken,
        completedAt: "2026-08-09T10:00:04.000Z",
        nextAttemptAt: "2026-08-09T10:00:06.000Z",
        result: {
          outcome: "failed",
          errorCode: "HTTP_ERROR",
          httpStatus: 503,
          latencyMs: 27,
        },
      }),
    ).resolves.toBe(true);
    await expect(
      webhooks.claim({
        deliveryId: delivery.deliveryId,
        claimToken: "30000000-0000-4000-8000-000000000020",
        claimedAt: "2026-08-09T10:00:05.999Z",
      }),
    ).resolves.toBeUndefined();

    const secondClaimToken = "30000000-0000-4000-8000-000000000021";
    await expect(
      webhooks.claim({
        deliveryId: delivery.deliveryId,
        claimToken: secondClaimToken,
        claimedAt: "2026-08-09T10:00:06.000Z",
      }),
    ).resolves.toMatchObject({ attemptNumber: 2 });
    await expect(
      webhooks.complete({
        deliveryId: delivery.deliveryId,
        claimToken: secondClaimToken,
        completedAt: "2026-08-09T10:00:07.000Z",
        result: {
          outcome: "failed",
          errorCode: "NETWORK_ERROR",
          latencyMs: 1_000,
        },
        terminalStatus: "exhausted",
      }),
    ).resolves.toBe(true);

    const attempts = await webhooks.findAttempts({
      ownerId: run.ownerId,
      deliveryId: delivery.deliveryId,
    });
    expect(attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        outcome: "failed",
        httpStatus: 503,
        latencyMs: 27,
        nextAttemptAt: "2026-08-09T10:00:06.000Z",
      }),
      expect.objectContaining({
        attemptNumber: 2,
        outcome: "failed",
        errorCode: "NETWORK_ERROR",
        latencyMs: 1_000,
      }),
    ]);
    await expect(
      webhooks.findAttempts({
        ownerId: "other-caller",
        deliveryId: delivery.deliveryId,
      }),
    ).resolves.toEqual([]);
    await expect(
      webhooks.findByEvent({
        ownerId: run.ownerId,
        eventIds: [delivery.eventId],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ deliveryId: delivery.deliveryId }),
    ]);
    await expect(
      webhooks.findByEndpoint({ ownerId: "other-caller", endpointId }),
    ).resolves.toEqual([]);
    await expect(
      webhooks.replay({
        ownerId: "other-caller",
        deliveryId: delivery.deliveryId,
        actorId: "operator:alice",
        replayedAt: "2026-08-09T10:00:08.000Z",
      }),
    ).resolves.toBeUndefined();

    const replay = await webhooks.replay({
      ownerId: run.ownerId,
      deliveryId: delivery.deliveryId,
      actorId: "operator:alice",
      replayedAt: "2026-08-09T10:00:08.000Z",
    });
    expect(replay).toMatchObject({
      eventId: delivery.eventId,
      runId: run.runId,
      endpointId,
      status: "pending",
      attemptCount: 0,
      replayNumber: 1,
      replayOfDeliveryId: delivery.deliveryId,
    });
    expect(replay?.deliveryId).not.toBe(delivery.deliveryId);
    const audit = await primaryPool.query<{
      source_delivery_id: string;
      replay_delivery_id: string;
      caller_id: string;
      actor_id: string;
    }>("SELECT * FROM webhook_delivery_replays");
    expect(audit.rows).toEqual([
      expect.objectContaining({
        source_delivery_id: delivery.deliveryId,
        replay_delivery_id: replay?.deliveryId,
        caller_id: run.ownerId,
        actor_id: "operator:alice",
      }),
    ]);
    const traced = await webhooks.findByEndpoint({
      ownerId: run.ownerId,
      endpointId,
    });
    expect(traced).toHaveLength(2);
    expect(new Set(traced.map((entry) => entry.eventId))).toEqual(
      new Set([delivery.eventId]),
    );
  });

  it("disables only the Endpoint that returns HTTP 410", async () => {
    const webhooks = postgresWebhookStore(primaryPool);
    const endpointIds = [
      "20000000-0000-4000-8000-000000000020",
      "20000000-0000-4000-8000-000000000021",
    ];
    for (const [index, endpointId] of endpointIds.entries()) {
      await webhooks.provisionEndpoint({
        endpointId,
        ownerId: "caller-webhook-gone",
        actorId: "operator:test",
        url: `https://hooks.example/gone-${index}`,
        secret: `whsec_${Buffer.alloc(32, 20 + index).toString("base64")}`,
        createdAt: "2026-08-09T10:00:00.000Z",
      });
    }
    const run = acceptedRun(54, {
      ownerId: "caller-webhook-gone",
      idempotencyKey: "webhook-gone",
    });
    await primaryStore.accept(run);
    const runClaim = await primaryStore.claim({
      runId: run.runId,
      claimToken: claimToken(54),
      claimedAt: "2026-08-09T10:00:01.000Z",
    });
    if (!runClaim) throw new Error("Expected Process Run claim");
    await primaryStore.complete({
      runId: run.runId,
      claimToken: runClaim.claimToken,
      completedAt: "2026-08-09T10:00:02.000Z",
      completion: { status: "succeeded", output: { value: "done" } },
    });
    const deliveries = await webhooks.findByRun({
      ownerId: run.ownerId,
      runIds: [run.runId],
    });
    const gone = deliveries.find((entry) => entry.endpointId === endpointIds[0]);
    if (!gone) throw new Error("Expected Webhook Delivery");
    const goneClaimToken = "30000000-0000-4000-8000-000000000022";
    await webhooks.claim({
      deliveryId: gone.deliveryId,
      claimToken: goneClaimToken,
      claimedAt: "2026-08-09T10:00:03.000Z",
    });
    await webhooks.complete({
      deliveryId: gone.deliveryId,
      claimToken: goneClaimToken,
      completedAt: "2026-08-09T10:00:04.000Z",
      result: {
        outcome: "failed",
        errorCode: "HTTP_ERROR",
        httpStatus: 410,
        latencyMs: 9,
      },
      terminalStatus: "failed",
      disableEndpoint: true,
    });

    const endpoints = await primaryPool.query<{
      endpoint_id: string;
      status: string;
    }>(
      "SELECT endpoint_id, status FROM webhook_endpoints ORDER BY endpoint_id",
    );
    expect(endpoints.rows).toEqual([
      { endpoint_id: endpointIds[0], status: "disabled" },
      { endpoint_id: endpointIds[1], status: "enabled" },
    ]);
  });

  it("encrypts, rotates, scopes, and audits Webhook Endpoint operations", async () => {
    const webhooks = postgresWebhookStore(primaryPool);
    const endpointId = "20000000-0000-4000-8000-000000000030";
    const oldSecret = `whsec_${Buffer.alloc(32, 30).toString("base64")}`;
    const newSecret = `whsec_${Buffer.alloc(32, 31).toString("base64")}`;
    await webhooks.provisionEndpoint({
      endpointId,
      ownerId: "caller-endpoint-security",
      actorId: "operator:creator",
      url: "https://hooks.example/original",
      secret: oldSecret,
      createdAt: "2026-08-09T10:00:00.000Z",
    });

    const raw = await primaryPool.query<{
      current_secret_envelope: string;
      previous_secret_envelope: string | null;
    }>(
      `
        SELECT current_secret_envelope, previous_secret_envelope
        FROM webhook_endpoints
        WHERE endpoint_id = $1
      `,
      [endpointId],
    );
    expect(raw.rows[0]?.current_secret_envelope).toMatch(/^enc\.v1\./);
    expect(JSON.stringify(raw.rows)).not.toContain(oldSecret);
    expect(raw.rows[0]?.previous_secret_envelope).toBeNull();
    const endpointViews = await webhooks.findEndpoints({
      ownerId: "caller-endpoint-security",
    });
    expect(endpointViews).toEqual([
      expect.objectContaining({
        endpointId,
        url: "https://hooks.example/original",
        status: "enabled",
      }),
    ]);
    expect(JSON.stringify(endpointViews)).not.toContain("secret");
    await expect(
      webhooks.findEndpoints({ ownerId: "other-caller" }),
    ).resolves.toEqual([]);
    await expect(
      webhooks.updateEndpointUrl({
        endpointId,
        ownerId: "other-caller",
        actorId: "operator:intruder",
        url: "https://hooks.example/intruder",
        updatedAt: "2026-08-09T10:00:01.000Z",
      }),
    ).resolves.toBeUndefined();
    await expect(
      webhooks.rotateEndpointSecret({
        endpointId,
        ownerId: "other-caller",
        actorId: "operator:intruder",
        secret: newSecret,
        rotatedAt: "2026-08-09T10:00:01.000Z",
        overlapMs: 60_000,
      }),
    ).resolves.toBeUndefined();

    await expect(
      webhooks.updateEndpointUrl({
        endpointId,
        ownerId: "caller-endpoint-security",
        actorId: "operator:editor",
        url: "https://hooks.example/updated",
        updatedAt: "2026-08-09T10:00:01.000Z",
      }),
    ).resolves.toMatchObject({ url: "https://hooks.example/updated" });
    await expect(
      webhooks.rotateEndpointSecret({
        endpointId,
        ownerId: "caller-endpoint-security",
        actorId: "operator:rotator",
        secret: newSecret,
        rotatedAt: "2026-08-09T10:00:02.000Z",
        overlapMs: 60_000,
      }),
    ).resolves.toMatchObject({ endpointId, status: "enabled" });

    const run = acceptedRun(55, {
      ownerId: "caller-endpoint-security",
      idempotencyKey: "secret-overlap",
    });
    await primaryStore.accept(run);
    const runClaim = await primaryStore.claim({
      runId: run.runId,
      claimToken: claimToken(55),
      claimedAt: "2026-08-09T10:00:03.000Z",
    });
    if (!runClaim) throw new Error("Expected Process Run claim");
    await primaryStore.complete({
      runId: run.runId,
      claimToken: runClaim.claimToken,
      completedAt: "2026-08-09T10:00:04.000Z",
      completion: { status: "succeeded", output: { value: "done" } },
    });
    const [delivery] = await webhooks.findByRun({
      ownerId: run.ownerId,
      runIds: [run.runId],
    });
    if (!delivery) throw new Error("Expected Webhook Delivery");
    await expect(
      webhooks.claim({
        deliveryId: delivery.deliveryId,
        claimToken: "30000000-0000-4000-8000-000000000030",
        claimedAt: "2026-08-09T10:00:05.000Z",
      }),
    ).resolves.toMatchObject({ secrets: [newSecret, oldSecret] });

    const afterOverlap = acceptedRun(57, {
      ownerId: "caller-endpoint-security",
      idempotencyKey: "secret-after-overlap",
    });
    await primaryStore.accept(afterOverlap);
    const afterOverlapRunClaim = await primaryStore.claim({
      runId: afterOverlap.runId,
      claimToken: claimToken(57),
      claimedAt: "2026-08-09T10:01:03.000Z",
    });
    if (!afterOverlapRunClaim) throw new Error("Expected Process Run claim");
    await primaryStore.complete({
      runId: afterOverlap.runId,
      claimToken: afterOverlapRunClaim.claimToken,
      completedAt: "2026-08-09T10:01:04.000Z",
      completion: { status: "succeeded", output: { value: "done" } },
    });
    const [afterOverlapDelivery] = await webhooks.findByRun({
      ownerId: afterOverlap.ownerId,
      runIds: [afterOverlap.runId],
    });
    if (!afterOverlapDelivery) throw new Error("Expected Webhook Delivery");
    await expect(
      webhooks.claim({
        deliveryId: afterOverlapDelivery.deliveryId,
        claimToken: "30000000-0000-4000-8000-000000000031",
        claimedAt: "2026-08-09T10:01:05.000Z",
      }),
    ).resolves.toMatchObject({ secrets: [newSecret] });

    await expect(
      webhooks.disableEndpoint({
        endpointId,
        ownerId: "caller-endpoint-security",
        actorId: "operator:disabler",
        disabledAt: "2026-08-09T10:00:06.000Z",
      }),
    ).resolves.toMatchObject({
      endpointId,
      status: "disabled",
      disabledAt: "2026-08-09T10:00:06.000Z",
    });
    await expect(
      webhooks.disableEndpoint({
        endpointId,
        ownerId: "other-caller",
        actorId: "operator:intruder",
        disabledAt: "2026-08-09T10:00:07.000Z",
      }),
    ).resolves.toBeUndefined();

    const audit = await webhooks.findEndpointAudit({
      ownerId: "caller-endpoint-security",
      endpointId,
    });
    expect(audit.map((event) => [event.action, event.actorId])).toEqual([
      ["provisioned", "operator:creator"],
      ["url_updated", "operator:editor"],
      ["secret_rotated", "operator:rotator"],
      ["disabled", "operator:disabler"],
    ]);
    await expect(
      webhooks.findEndpointAudit({ ownerId: "other-caller", endpointId }),
    ).resolves.toEqual([]);
  });

  it("audits forbidden registration and DNS rebinding before any outbound request", async () => {
    const secretCipher = createWebhookSecretCipher({ key: Buffer.alloc(32, 32) });
    const rejectedEndpointId = "20000000-0000-4000-8000-000000000031";
    const forbiddenStore = createPostgresWebhookDeliveryStore({
      pool: primaryPool,
      secretCipher,
      targetPolicy: createWebhookTargetPolicy({
        resolveHostname: async () => [
          { address: "169.254.169.254", family: 4 },
        ],
      }),
    });
    await expect(
      forbiddenStore.provisionEndpoint({
        endpointId: rejectedEndpointId,
        ownerId: "caller-security-rejection",
        actorId: "operator:security",
        url: "https://metadata-alias.example/hook",
        secret: `whsec_${Buffer.alloc(32, 32).toString("base64")}`,
        createdAt: "2026-08-09T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "WEBHOOK_TARGET_FORBIDDEN_ADDRESS" });
    await expect(
      forbiddenStore.findEndpointAudit({
        ownerId: "caller-security-rejection",
        endpointId: rejectedEndpointId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        action: "registration_rejected",
        reasonCode: "WEBHOOK_TARGET_FORBIDDEN_ADDRESS",
      }),
    ]);
    await expect(
      forbiddenStore.findEndpoints({ ownerId: "caller-security-rejection" }),
    ).resolves.toEqual([]);

    let resolution = 0;
    const rebindingPolicy = createWebhookTargetPolicy({
      resolveHostname: async () => {
        resolution += 1;
        return resolution === 1
          ? [{ address: "93.184.216.34", family: 4 as const }]
          : [{ address: "127.0.0.1", family: 4 as const }];
      },
    });
    const webhooks = createPostgresWebhookDeliveryStore({
      pool: primaryPool,
      secretCipher,
      targetPolicy: rebindingPolicy,
    });
    const endpointId = "20000000-0000-4000-8000-000000000032";
    await webhooks.provisionEndpoint({
      endpointId,
      ownerId: "caller-dns-rebinding",
      actorId: "operator:security",
      url: "https://rebinding.example/hook",
      secret: `whsec_${Buffer.alloc(32, 33).toString("base64")}`,
      createdAt: "2026-08-09T10:00:00.000Z",
    });
    const run = acceptedRun(56, {
      ownerId: "caller-dns-rebinding",
      idempotencyKey: "dns-rebinding",
    });
    await primaryStore.accept(run);
    const runClaim = await primaryStore.claim({
      runId: run.runId,
      claimToken: claimToken(56),
      claimedAt: "2026-08-09T10:00:01.000Z",
    });
    if (!runClaim) throw new Error("Expected Process Run claim");
    await primaryStore.complete({
      runId: run.runId,
      claimToken: runClaim.claimToken,
      completedAt: "2026-08-09T10:00:02.000Z",
      completion: { status: "succeeded", output: { value: "done" } },
    });
    const [delivery] = await webhooks.findByRun({
      ownerId: run.ownerId,
      runIds: [run.runId],
    });
    if (!delivery) throw new Error("Expected Webhook Delivery");
    const worker = createWebhookDeliveryWorker({
      store: webhooks,
      sender: createStandardWebhookHttpSender({ targetPolicy: rebindingPolicy }),
      clock: sequenceClock([
        "2026-08-09T10:00:03.000Z",
        "2026-08-09T10:00:04.000Z",
      ]),
      createClaimToken: () => "30000000-0000-4000-8000-000000000032",
    });
    await expect(
      worker.process({ schemaVersion: 1, deliveryId: delivery.deliveryId }),
    ).resolves.toBe("processed");
    expect(resolution).toBe(2);
    await expect(
      webhooks.findByRun({ ownerId: run.ownerId, runIds: [run.runId] }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        lastErrorCode: "WEBHOOK_TARGET_FORBIDDEN_ADDRESS",
      }),
    ]);
    await expect(
      webhooks.findAttempts({
        ownerId: run.ownerId,
        deliveryId: delivery.deliveryId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        outcome: "failed",
        errorCode: "WEBHOOK_TARGET_FORBIDDEN_ADDRESS",
      }),
    ]);
    await expect(
      webhooks.findEndpoints({ ownerId: run.ownerId }),
    ).resolves.toEqual([
      expect.objectContaining({ endpointId, status: "disabled" }),
    ]);
    await expect(
      webhooks.findEndpointAudit({ ownerId: run.ownerId, endpointId }),
    ).resolves.toEqual([
      expect.objectContaining({ action: "provisioned" }),
      expect.objectContaining({
        action: "delivery_target_rejected",
        reasonCode: "WEBHOOK_TARGET_FORBIDDEN_ADDRESS",
      }),
    ]);
  });

  it("expires input, result, and metadata independently without changing terminal status", async () => {
    const retentionStore = createPostgresProcessRunStore({
      pool: primaryPool,
      retention: {
        acceptedInputMs: 1_000,
        resultMs: 2_000,
        metadataMs: 10_000,
      },
    });
    const cleanup = createPostgresRetentionCleanup({
      pool: primaryPool,
      webhookDeliveryHistoryMs: 30_000,
    });
    const terminal = acceptedRun(61, {
      ownerId: "caller-retention",
      idempotencyKey: "terminal-retention",
      inputValue: "private-input",
    });
    const queued = acceptedRun(62, {
      ownerId: "caller-retention",
      idempotencyKey: "queued-retention",
      inputValue: "still-runnable",
    });
    await retentionStore.accept(terminal);
    await retentionStore.accept(queued);
    const claim = await retentionStore.claim({
      runId: terminal.runId,
      claimToken: claimToken(61),
      claimedAt: "2026-08-09T10:00:00.100Z",
    });
    if (!claim) throw new Error("Expected Process Run claim");
    await retentionStore.complete({
      runId: terminal.runId,
      claimToken: claim.claimToken,
      completedAt: "2026-08-09T10:00:00.500Z",
      completion: {
        status: "succeeded",
        output: { value: "private-output" },
      },
    });

    await expect(
      cleanup.cleanupBatch({
        asOf: "2026-08-09T10:00:00.999Z",
        batchSize: 10,
      }),
    ).resolves.toMatchObject({ examined: 0 });
    await expect(
      cleanup.cleanupBatch({
        asOf: "2026-08-09T10:00:01.000Z",
        batchSize: 10,
      }),
    ).resolves.toMatchObject({
      inputContentsDeleted: 1,
      resultsDeleted: 0,
      runsDeleted: 0,
    });
    await expect(
      retentionStore.findOwned(terminal.runId, terminal.ownerId),
    ).resolves.toMatchObject({
      status: "succeeded",
      finishedAt: "2026-08-09T10:00:00.500Z",
      output: { value: "private-output" },
    });
    expect(
      (await retentionStore.findOwned(terminal.runId, terminal.ownerId))
        ?.acceptedInput,
    ).toBeUndefined();
    await expect(
      retentionStore.findOwned(queued.runId, queued.ownerId),
    ).resolves.toMatchObject({
      status: "queued",
      acceptedInput: expect.objectContaining({
        input: { value: "still-runnable" },
      }),
    });

    await expect(
      cleanup.cleanupBatch({
        asOf: "2026-08-09T10:00:02.499Z",
        batchSize: 10,
      }),
    ).resolves.toMatchObject({ resultsDeleted: 0 });
    await expect(
      cleanup.cleanupBatch({
        asOf: "2026-08-09T10:00:02.500Z",
        batchSize: 10,
      }),
    ).resolves.toMatchObject({ resultsDeleted: 1, runsDeleted: 0 });
    const publicRuns = createAsyncProcessRuns({
      registry: createProcessRegistry([]),
      store: retentionStore,
    });
    await expect(
      publicRuns.find(terminal.runId, { callerId: terminal.ownerId }),
    ).resolves.toEqual({
      runId: terminal.runId,
      process: terminal.process,
      version: terminal.version,
      status: "succeeded",
      createdAt: terminal.createdAt,
      startedAt: "2026-08-09T10:00:00.100Z",
      finishedAt: "2026-08-09T10:00:00.500Z",
      resultAvailability: "expired",
      resultExpiredAt: "2026-08-09T10:00:02.500Z",
    });
    await expect(
      cleanup.cleanupBatch({
        asOf: "2026-08-09T10:00:02.500Z",
        batchSize: 10,
      }),
    ).resolves.toMatchObject({
      inputContentsDeleted: 0,
      resultsDeleted: 0,
      runsDeleted: 0,
    });

    await expect(
      cleanup.cleanupBatch({
        asOf: "2026-08-09T10:00:10.000Z",
        batchSize: 10,
      }),
    ).resolves.toMatchObject({ runsDeleted: 1 });
    await expect(
      retentionStore.findOwned(terminal.runId, terminal.ownerId),
    ).resolves.toBeUndefined();
    await expect(
      retentionStore.findOwned(queued.runId, queued.ownerId),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("rolls back a failed cleanup batch and resumes from its durable cursor", async () => {
    const retentionStore = createPostgresProcessRunStore({
      pool: primaryPool,
      retention: {
        acceptedInputMs: 1,
        resultMs: 1,
        metadataMs: 60_000,
      },
    });
    const runs = [
      acceptedRun(63, {
        ownerId: "caller-cleanup-resume",
        idempotencyKey: "cleanup-resume-1",
      }),
      acceptedRun(64, {
        ownerId: "caller-cleanup-resume",
        idempotencyKey: "cleanup-resume-2",
      }),
    ];
    for (const [index, run] of runs.entries()) {
      await retentionStore.accept(run);
      const claim = await retentionStore.claim({
        runId: run.runId,
        claimToken: claimToken(63 + index),
        claimedAt: "2026-08-09T10:00:00.001Z",
      });
      if (!claim) throw new Error("Expected Process Run claim");
      await retentionStore.complete({
        runId: run.runId,
        claimToken: claim.claimToken,
        completedAt: "2026-08-09T10:00:00.002Z",
        completion: { status: "succeeded", output: { value: run.runId } },
      });
    }
    const duplicateAuditId = "40000000-0000-4000-8000-000000000001";
    const cleanup = createPostgresRetentionCleanup({
      pool: primaryPool,
      webhookDeliveryHistoryMs: 30_000,
      createCleanupId: () => duplicateAuditId,
    });
    const first = await cleanup.cleanupBatch({
      asOf: "2026-08-09T10:00:01.000Z",
      batchSize: 1,
    });
    expect(first).toMatchObject({
      examined: 1,
      inputContentsDeleted: 1,
      resultsDeleted: 1,
      nextCursor: runs[0]?.runId,
    });
    await expect(
      cleanup.cleanupBatch({
        asOf: "2026-08-09T10:00:01.000Z",
        batchSize: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      retentionStore.findOwned(runs[1]!.runId, runs[1]!.ownerId),
    ).resolves.toMatchObject({
      acceptedInput: expect.any(Object),
      output: { value: runs[1]!.runId },
    });

    const resumed = await createPostgresRetentionCleanup({
      pool: primaryPool,
      webhookDeliveryHistoryMs: 30_000,
      createCleanupId: () =>
        "40000000-0000-4000-8000-000000000002",
    }).cleanupBatch({
      asOf: "2026-08-09T10:00:01.000Z",
      batchSize: 1,
      cursor: first.nextCursor,
    });
    expect(resumed).toMatchObject({
      examined: 1,
      inputContentsDeleted: 1,
      resultsDeleted: 1,
    });
    expect(resumed.nextCursor).toBeUndefined();
    const audit = await primaryPool.query<{
      cleanup_id: string;
      cursor_run_id: string | null;
      next_cursor_run_id: string | null;
    }>(
      "SELECT cleanup_id, cursor_run_id, next_cursor_run_id FROM retention_cleanup_batches ORDER BY cleanup_id",
    );
    expect(audit.rows).toEqual([
      {
        cleanup_id: duplicateAuditId,
        cursor_run_id: null,
        next_cursor_run_id: runs[0]?.runId,
      },
      {
        cleanup_id: "40000000-0000-4000-8000-000000000002",
        cursor_run_id: runs[0]?.runId,
        next_cursor_run_id: null,
      },
    ]);
  });

  it("makes concurrent cleanup idempotent while owner queries remain valid", async () => {
    const retentionStore = createPostgresProcessRunStore({
      pool: primaryPool,
      retention: { acceptedInputMs: 1, resultMs: 1, metadataMs: 60_000 },
    });
    const run = acceptedRun(65, {
      ownerId: "caller-cleanup-concurrent",
      idempotencyKey: "cleanup-concurrent",
    });
    await retentionStore.accept(run);
    const claim = await retentionStore.claim({
      runId: run.runId,
      claimToken: claimToken(65),
      claimedAt: "2026-08-09T10:00:00.001Z",
    });
    if (!claim) throw new Error("Expected Process Run claim");
    await retentionStore.complete({
      runId: run.runId,
      claimToken: claim.claimToken,
      completedAt: "2026-08-09T10:00:00.002Z",
      completion: { status: "failed", error: {
        code: "DEPENDENCY_FAILURE",
        message: "The dependency is unavailable",
      } },
    });
    const cleanups = [1, 2].map((index) =>
      createPostgresRetentionCleanup({
        pool: index === 1 ? primaryPool : secondaryPool,
        webhookDeliveryHistoryMs: 30_000,
        createCleanupId: () =>
          `40000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      }),
    );
    const [left, right, queried] = await Promise.all([
      cleanups[0]!.cleanupBatch({
        asOf: "2026-08-09T10:00:01.000Z",
        batchSize: 10,
      }),
      cleanups[1]!.cleanupBatch({
        asOf: "2026-08-09T10:00:01.000Z",
        batchSize: 10,
      }),
      retentionStore.findOwned(run.runId, run.ownerId),
    ]);
    expect(left.inputContentsDeleted + right.inputContentsDeleted).toBe(1);
    expect(left.resultsDeleted + right.resultsDeleted).toBe(1);
    expect(["failed"]).toContain(queried?.status);
    await expect(
      retentionStore.findOwned(run.runId, run.ownerId),
    ).resolves.toMatchObject({
      status: "failed",
      resultExpiredAt: "2026-08-09T10:00:01.000Z",
    });
  });

  it("retains Delivery records while deleting their attempt history at its own boundary", async () => {
    const webhooks = postgresWebhookStore(primaryPool);
    await webhooks.provisionEndpoint({
      endpointId: "20000000-0000-4000-8000-000000000041",
      ownerId: "caller-delivery-retention",
      actorId: "operator:retention-test",
      url: "https://hooks.example/retention",
      secret: `whsec_${Buffer.alloc(32, 41).toString("base64")}`,
      createdAt: "2026-08-09T10:00:00.000Z",
    });
    const run = acceptedRun(66, {
      ownerId: "caller-delivery-retention",
      idempotencyKey: "delivery-retention",
    });
    await primaryStore.accept(run);
    const runClaim = await primaryStore.claim({
      runId: run.runId,
      claimToken: claimToken(66),
      claimedAt: "2026-08-09T10:00:01.000Z",
    });
    if (!runClaim) throw new Error("Expected Process Run claim");
    await primaryStore.complete({
      runId: run.runId,
      claimToken: runClaim.claimToken,
      completedAt: "2026-08-09T10:00:02.000Z",
      completion: { status: "succeeded", output: { value: "complete" } },
    });
    const [delivery] = await webhooks.findByRun({
      ownerId: run.ownerId,
      runIds: [run.runId],
    });
    if (!delivery) throw new Error("Expected Webhook Delivery");
    const deliveryClaimToken = "30000000-0000-4000-8000-000000000041";
    await webhooks.claim({
      deliveryId: delivery.deliveryId,
      claimToken: deliveryClaimToken,
      claimedAt: "2026-08-09T10:00:03.000Z",
    });
    await webhooks.complete({
      deliveryId: delivery.deliveryId,
      claimToken: deliveryClaimToken,
      completedAt: "2026-08-09T10:00:04.000Z",
      result: { outcome: "succeeded", httpStatus: 204, latencyMs: 10 },
    });
    const cleanup = createPostgresRetentionCleanup({
      pool: primaryPool,
      webhookDeliveryHistoryMs: 1_000,
    });

    await expect(
      cleanup.cleanupBatch({
        asOf: "2026-08-09T10:00:04.999Z",
        batchSize: 10,
      }),
    ).resolves.toMatchObject({ deliveryAttemptsDeleted: 0 });
    await expect(
      cleanup.cleanupBatch({
        asOf: "2026-08-09T10:00:05.000Z",
        batchSize: 10,
      }),
    ).resolves.toMatchObject({
      deliveryAttemptsDeleted: 1,
      runsDeleted: 0,
    });
    await expect(
      webhooks.findAttempts({
        ownerId: run.ownerId,
        deliveryId: delivery.deliveryId,
      }),
    ).resolves.toEqual([]);
    await expect(
      webhooks.findByRun({ ownerId: run.ownerId, runIds: [run.runId] }),
    ).resolves.toEqual([
      expect.objectContaining({
        deliveryId: delivery.deliveryId,
        status: "succeeded",
      }),
    ]);
    await expect(
      cleanup.cleanupBatch({
        asOf: "2026-08-09T10:00:05.000Z",
        batchSize: 10,
      }),
    ).resolves.toMatchObject({ examined: 0 });
  });

  it("rejects an illegal terminal transition at the database boundary", async () => {
    const run = acceptedRun(60, {
      ownerId: "caller-constraint",
      idempotencyKey: "constraint",
    });
    await primaryStore.accept(run);

    await expect(
      primaryPool.query(
        "UPDATE process_runs SET status = 'succeeded' WHERE run_id = $1",
        [run.runId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(primaryStore.findOwned(run.runId, run.ownerId)).resolves.toMatchObject(
      { status: "queued" },
    );
  });

  it("serves the authenticated async HTTP resource from Startup Construction", async () => {
    const gatewaySecret = "integration-gateway-secret-at-least-32-bytes";
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: "https://business.example",
      ASYNC_PROCESS_RUNS_ENABLED: "true",
      DATABASE_URL: databaseUrl,
      ASYNC_GATEWAY_SHARED_SECRET: gatewaySecret,
      PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS: "86400000",
      PROCESS_RUN_RESULT_RETENTION_MS: "604800000",
      PROCESS_RUN_METADATA_RETENTION_MS: "2592000000",
      ASYNC_RELEASE_STAGE: "internal",
      ASYNC_GLOBAL_BACKLOG_LIMIT: "1000",
      ASYNC_CALLER_BACKLOG_LIMIT: "100",
      ASYNC_BACKLOG_RETRY_AFTER_SECONDS: "5",
    });
    const { url } = await constructed.application.listen();
    const headers = {
      "content-type": "application/json",
      "idempotency-key": "http-integration",
      [callerIdentityHeader]: "service:http-integration",
      [gatewayAuthenticationHeader]: gatewaySecret,
    };

    try {
      const readiness = await fetch(`${url}/readyz`);
      expect(readiness.status).toBe(200);
      const submission = await fetch(`${url}/process-runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          process: "content-processing",
          version: "v1",
          input: { content: "accepted request" },
        }),
      });
      const submitted = (await submission.json()) as { runId: string };
      expect(submission.status).toBe(202);
      expect(submission.headers.get("location")).toBe(
        `/process-runs/${submitted.runId}`,
      );

      const query = await fetch(`${url}/process-runs/${submitted.runId}`, {
        headers: {
          [callerIdentityHeader]: "service:http-integration",
          [gatewayAuthenticationHeader]: gatewaySecret,
        },
      });
      expect(query.status).toBe(200);
      expect(await query.json()).toMatchObject({
        runId: submitted.runId,
        status: "queued",
      });

      const invalid = await fetch(`${url}/process-runs`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": "invalid-request" },
        body: JSON.stringify({
          process: "content-processing",
          version: "v1",
          input: { content: "   " },
        }),
      });
      expect(invalid.status).toBe(400);
      const count = await primaryPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM process_runs",
      );
      expect(count.rows[0]?.count).toBe("1");
    } finally {
      await constructed.application.close();
    }
  });
});

function postgresStore(pool: Pool): ProcessRunStore {
  return createPostgresProcessRunStore({ pool, retention: RETENTION });
}

function postgresWebhookStore(pool: Pool) {
  return createPostgresWebhookDeliveryStore({
    pool,
    secretCipher: createWebhookSecretCipher({ key: Buffer.alloc(32, 11) }),
    targetPolicy: createWebhookTargetPolicy({
      resolveHostname: async () => [
        { address: "93.184.216.34", family: 4 },
      ],
    }),
  });
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
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      "PostgreSQL integration tests require a database name ending in _test",
    );
  }
}

function acceptedRun(
  index: number,
  overrides: {
    ownerId: string;
    idempotencyKey: string;
    inputValue?: string;
  },
): Parameters<ProcessRunStore["accept"]>[0] {
  return {
    runId: runId(index),
    ownerId: overrides.ownerId,
    idempotencyKey: overrides.idempotencyKey,
    requestFingerprint: "a".repeat(64),
    process: "test-processing",
    version: "v1",
    acceptedInput: {
      schemaVersion: 1,
      process: "test-processing",
      version: "v1",
      input: { value: overrides.inputValue ?? "request" },
    },
    createdAt: "2026-08-09T10:00:00.000Z",
  };
}

function runId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function claimToken(index: number): string {
  return `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function sequenceClock(values: readonly string[]): () => string {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (!value) throw new Error("Clock exhausted");
    return value;
  };
}

const RETENTION = {
  acceptedInputMs: 86_400_000,
  resultMs: 604_800_000,
  metadataMs: 2_592_000_000,
} as const;
