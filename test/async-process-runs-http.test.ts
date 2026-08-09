import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createProcessingApplication } from "../src/application.js";
import { createAsyncProcessRuns } from "../src/async-process-runs.js";
import type { CallerIdentityResolver } from "../src/caller-identity.js";
import { createInMemoryProcessRunStore } from "../src/process-run-store.js";
import {
  createProcessRegistry,
  defineProcessRegistration,
} from "../src/process-runtime.js";
import { createInMemoryProcessWorkQueue } from "../src/process-work-queue.js";

const runningApplications: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    runningApplications.splice(0).map((application) => application.close()),
  );
});

describe("Async Process Runs HTTP Interface", () => {
  it("keeps async routes disabled while preserving readiness and sync execution", async () => {
    const application = createProcessingApplication({
      executor: {
        execute: async () => ({
          runId: RUN_ID,
          process: "test-processing",
          version: "v1",
          status: "succeeded",
          output: { value: "sync" },
        }),
      },
      http: { logSink: () => {} },
    });
    runningApplications.push(application);
    const { url } = await application.listen();

    const disabledSubmit = await fetch(`${url}/process-runs`, {
      method: "POST",
    });
    const disabledFind = await fetch(`${url}/process-runs/${RUN_ID}`);
    const readiness = await fetch(`${url}/readyz`);
    const sync = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(disabledSubmit.status).toBe(404);
    expect(disabledFind.status).toBe(404);
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toEqual({ status: "ready" });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ status: "succeeded" });
  });

  it("accepts and queries an authenticated queued Process Run", async () => {
    const fixture = await startFixture();

    const submission = await submit(fixture.url, {
      callerId: "caller-a",
      idempotencyKey: "request-1",
    });

    expect(submission.status).toBe(202);
    expect(submission.headers.get("location")).toBe(`/process-runs/${RUN_ID}`);
    expect(submission.headers.get("retry-after")).toBe("2");
    expect(submission.headers.get("cache-control")).toBe("no-store");
    expect(await submission.json()).toEqual({
      runId: RUN_ID,
      process: "test-processing",
      version: "v1",
      status: "queued",
      createdAt: "2026-08-09T10:00:00.000Z",
    });

    const query = await find(fixture.url, RUN_ID, "caller-a");
    expect(query.status).toBe(200);
    expect(query.headers.get("retry-after")).toBe("2");
    expect(query.headers.get("cache-control")).toBe("no-store");
    expect(await query.json()).toMatchObject({
      runId: RUN_ID,
      status: "queued",
    });
  });

  it("does not reveal a run to another authenticated caller", async () => {
    const fixture = await startFixture();
    await submit(fixture.url, {
      callerId: "caller-a",
      idempotencyKey: "request-1",
    });

    const unauthorized = await find(fixture.url, RUN_ID, "caller-b");
    const unknown = await find(fixture.url, UNKNOWN_RUN_ID, "caller-b");
    expect(unauthorized.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await unauthorized.json()).toEqual(await unknown.json());
  });

  it("requires both trusted identity and a bounded Idempotency-Key", async () => {
    const fixture = await startFixture();

    const missingIdentity = await fetch(`${fixture.url}/process-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "request-1",
      },
      body: JSON.stringify(validRequest()),
    });
    const missingKey = await fetch(`${fixture.url}/process-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-caller": "caller-a",
      },
      body: JSON.stringify(validRequest()),
    });
    const oversizedKey = await submit(fixture.url, {
      callerId: "caller-a",
      idempotencyKey: "x".repeat(513),
    });

    expect(missingIdentity.status).toBe(401);
    expect(await missingIdentity.json()).toMatchObject({
      error: { code: "CALLER_UNAUTHORIZED" },
    });
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
    });
    expect(oversizedKey.status).toBe(400);
    expect(await oversizedKey.json()).toMatchObject({
      error: { code: "INVALID_IDEMPOTENCY_KEY" },
    });
    await expect(fixture.queue.take()).resolves.toBeUndefined();
  });

  it("maps acceptance rejection without creating a run or queue item", async () => {
    const fixture = await startFixture();

    const invalid = await submit(fixture.url, {
      callerId: "caller-a",
      idempotencyKey: "invalid",
      request: {
        process: "test-processing",
        version: "v1",
        input: { value: 42 },
      },
    });
    const missing = await submit(fixture.url, {
      callerId: "caller-a",
      idempotencyKey: "missing",
      request: {
        process: "missing",
        version: "v1",
        input: { value: "request" },
      },
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "PROCESS_NOT_FOUND" },
    });
    await expect(fixture.queue.take()).resolves.toBeUndefined();
    await expect(
      fixture.store.findOwned(RUN_ID, "caller-a"),
    ).resolves.toBeUndefined();
  });

  it("replays the same resource and rejects inconsistent key reuse", async () => {
    const fixture = await startFixture();
    const first = await submit(fixture.url, {
      callerId: "caller-a",
      idempotencyKey: "shared",
    });
    const firstBody = await first.json();
    const replay = await submit(fixture.url, {
      callerId: "caller-a",
      idempotencyKey: "shared",
    });
    const conflict = await submit(fixture.url, {
      callerId: "caller-a",
      idempotencyKey: "shared",
      request: {
        process: "test-processing",
        version: "v1",
        input: { value: "different" },
      },
    });

    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(firstBody);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
    await expect(fixture.queue.take()).resolves.toEqual({
      schemaVersion: 1,
      runId: RUN_ID,
    });
    await expect(fixture.queue.take()).resolves.toBeUndefined();
  });

  it("returns terminal content without asking the caller to keep polling", async () => {
    const fixture = await startFixture();
    await submit(fixture.url, {
      callerId: "caller-a",
      idempotencyKey: "request-1",
    });
    const claim = await fixture.store.claim({
      runId: RUN_ID,
      claimToken: CLAIM_TOKEN,
      claimedAt: "2026-08-09T10:00:01.000Z",
    });
    if (!claim) throw new Error("Expected Process Run claim");
    await fixture.store.complete({
      runId: RUN_ID,
      claimToken: CLAIM_TOKEN,
      completedAt: "2026-08-09T10:00:02.000Z",
      completion: { status: "succeeded", output: { value: "complete" } },
    });

    const response = await find(fixture.url, RUN_ID, "caller-a");
    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toMatchObject({
      status: "succeeded",
      output: { value: "complete" },
    });
  });

  it("separates liveness from dependency readiness", async () => {
    const readiness = vi.fn<() => Promise<void>>().mockResolvedValue();
    const fixture = await startFixture({ readiness });

    const health = await fetch(`${fixture.url}/healthz`);
    expect(health.status).toBe(200);
    expect(readiness).not.toHaveBeenCalled();
    const ready = await fetch(`${fixture.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
    expect(readiness).toHaveBeenCalledTimes(1);

    readiness.mockRejectedValueOnce(new Error("database unavailable"));
    const notReady = await fetch(`${fixture.url}/readyz`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ status: "not_ready" });
  });

  it("sanitizes unexpected submission failures as retryable transport errors", async () => {
    const sensitiveFailure = "postgres password secret-value";
    const application = createProcessingApplication({
      executor: unusedExecutor(),
      http: {
        logSink: () => {},
        asyncProcessRuns: {
          runs: {
            submit: async () => {
              throw new Error(sensitiveFailure);
            },
            find: async () => undefined,
          },
          callerIdentity: fakeCallerIdentity,
          readiness: async () => {},
        },
      },
    });
    runningApplications.push(application);
    const { url } = await application.listen();

    const response = await submit(url, {
      callerId: "caller-a",
      idempotencyKey: "request-1",
    });
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(body).toMatchObject({
      error: { code: "ASYNC_SERVICE_UNAVAILABLE" },
    });
    expect(JSON.stringify(body)).not.toContain(sensitiveFailure);
  });
});

async function startFixture(options: { readiness?: () => Promise<void> } = {}) {
  const registration = defineProcessRegistration({
    id: "test-processing",
    version: "v1",
    inputSchema: z.strictObject({ value: z.string() }),
    outputSchema: z.strictObject({ value: z.string() }),
    execute: async (input) => input,
  });
  const store = createInMemoryProcessRunStore({ maxRuns: 10 });
  const queue = createInMemoryProcessWorkQueue({ maxJobs: 10 });
  const runs = createAsyncProcessRuns({
    registry: createProcessRegistry([registration]),
    store,
    queue,
    clock: () => "2026-08-09T10:00:00.000Z",
    createRunId: () => RUN_ID,
  });
  const application = createProcessingApplication({
    executor: unusedExecutor(),
    http: {
      logSink: () => {},
      asyncProcessRuns: {
        runs,
        callerIdentity: fakeCallerIdentity,
        readiness: options.readiness ?? (async () => {}),
      },
    },
  });
  runningApplications.push(application);
  const { url } = await application.listen();
  return { url, store, queue };
}

function submit(
  url: string,
  options: {
    callerId: string;
    idempotencyKey: string;
    request?: unknown;
  },
): Promise<Response> {
  return fetch(`${url}/process-runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": options.idempotencyKey,
      "x-test-caller": options.callerId,
    },
    body: JSON.stringify(options.request ?? validRequest()),
  });
}

function find(url: string, runId: string, callerId: string): Promise<Response> {
  return fetch(`${url}/process-runs/${runId}`, {
    headers: { "x-test-caller": callerId },
  });
}

function validRequest() {
  return {
    process: "test-processing",
    version: "v1",
    input: { value: "request" },
  };
}

function unusedExecutor() {
  return {
    execute: async () => ({
      runId: UNKNOWN_RUN_ID,
      process: "test-processing",
      version: "v1",
      status: "succeeded" as const,
      output: { value: "unused" },
    }),
  };
}

const fakeCallerIdentity: CallerIdentityResolver = {
  resolve: async (headers) => {
    const callerId = headers["x-test-caller"];
    return typeof callerId === "string" ? { callerId } : undefined;
  },
};

const RUN_ID = "00000000-0000-4000-8000-000000000101";
const UNKNOWN_RUN_ID = "00000000-0000-4000-8000-000000000999";
const CLAIM_TOKEN = "10000000-0000-4000-8000-000000000101";
