import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
  callerIdentityHeader,
  gatewayAuthenticationHeader,
} from "../src/caller-identity.js";
import { createPostgresProcessRunStore } from "../src/postgres-process-run-store.js";
import { createPostgresWebhookDeliveryStore } from "../src/postgres-webhook-delivery-store.js";
import type { ProcessRunStore } from "../src/process-run-store.js";
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
    await primaryPool.query("TRUNCATE webhook_endpoints, process_runs CASCADE");
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
    const webhooks = createPostgresWebhookDeliveryStore({ pool: primaryPool });
    await webhooks.provisionEndpoint({
      endpointId: "20000000-0000-4000-8000-000000000001",
      ownerId: "caller-webhook",
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
    const webhooks = createPostgresWebhookDeliveryStore({ pool: primaryPool });
    const endpointId = "20000000-0000-4000-8000-000000000019";
    await webhooks.provisionEndpoint({
      endpointId,
      ownerId: "caller-webhook-retry",
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
    const webhooks = createPostgresWebhookDeliveryStore({ pool: primaryPool });
    const endpointIds = [
      "20000000-0000-4000-8000-000000000020",
      "20000000-0000-4000-8000-000000000021",
    ];
    for (const [index, endpointId] of endpointIds.entries()) {
      await webhooks.provisionEndpoint({
        endpointId,
        ownerId: "caller-webhook-gone",
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

const RETENTION = {
  acceptedInputMs: 86_400_000,
  resultMs: 604_800_000,
  metadataMs: 2_592_000_000,
} as const;
