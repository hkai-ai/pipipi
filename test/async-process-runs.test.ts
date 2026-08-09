import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAsyncProcessRuns } from "../src/async-process-runs.js";
import { createInMemoryProcessRunStore } from "../src/process-run-store.js";
import {
  createProcessAttemptRunner,
  createProcessRegistry,
  defineProcessRegistration,
  failProcess,
  type ProcessRegistration,
} from "../src/process-runtime.js";
import { createInMemoryProcessWorkQueue } from "../src/process-work-queue.js";
import {
  createProcessWorker,
  createProcessWorkerDrain,
} from "../src/process-worker.js";

describe("Async Process Runs", () => {
  it("moves an accepted run through queued, running, and succeeded", async () => {
    let releaseExecution: (() => void) | undefined;
    let markExecutionStarted: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const executionRelease = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const process = registration("v1", async (value) => {
      markExecutionStarted?.();
      await executionRelease;
      return { value: value.toUpperCase() };
    });
    const fixture = createFixture([process]);

    const submission = await fixture.runs.submit(request("v1", "request"), {
      callerId: "caller-a",
      idempotencyKey: "request-1",
    });
    expect(submission).toEqual({
      accepted: true,
      runId: RUN_IDS[0],
      process: "test-processing",
      version: "v1",
      status: "queued",
      createdAt: "2026-08-09T10:00:00.000Z",
    });
    expect(await fixture.runs.find(RUN_IDS[0], caller("caller-a"))).toEqual({
      runId: RUN_IDS[0],
      process: "test-processing",
      version: "v1",
      status: "queued",
      createdAt: "2026-08-09T10:00:00.000Z",
    });

    const draining = fixture.drain.drainOne();
    await executionStarted;
    expect(await fixture.runs.find(RUN_IDS[0], caller("caller-a"))).toEqual({
      runId: RUN_IDS[0],
      process: "test-processing",
      version: "v1",
      status: "running",
      createdAt: "2026-08-09T10:00:00.000Z",
      startedAt: "2026-08-09T10:00:01.000Z",
    });

    releaseExecution?.();
    await expect(draining).resolves.toBe("processed");
    expect(await fixture.runs.find(RUN_IDS[0], caller("caller-a"))).toEqual({
      runId: RUN_IDS[0],
      process: "test-processing",
      version: "v1",
      status: "succeeded",
      createdAt: "2026-08-09T10:00:00.000Z",
      startedAt: "2026-08-09T10:00:01.000Z",
      finishedAt: "2026-08-09T10:00:02.000Z",
      output: { value: "REQUEST" },
    });
  });

  it("persists a sanitized Business Process failure", async () => {
    const process = defineProcessRegistration({
      id: "test-processing",
      version: "v1",
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string() }),
      execute: async () =>
        failProcess("DEPENDENCY_FAILURE", "The dependency is unavailable"),
    });
    const fixture = createFixture([process]);
    await fixture.runs.submit(request("v1", "request"), {
      callerId: "caller-a",
      idempotencyKey: "request-1",
    });

    await expect(fixture.drain.drainOne()).resolves.toBe("processed");
    expect(await fixture.runs.find(RUN_IDS[0], caller("caller-a"))).toEqual({
      runId: RUN_IDS[0],
      process: "test-processing",
      version: "v1",
      status: "failed",
      createdAt: "2026-08-09T10:00:00.000Z",
      startedAt: "2026-08-09T10:00:01.000Z",
      finishedAt: "2026-08-09T10:00:02.000Z",
      error: {
        code: "DEPENDENCY_FAILURE",
        message: "The dependency is unavailable",
      },
    });
  });

  it("rejects invalid requests before allocating a run or queue job", async () => {
    const createRunId = vi.fn(() => RUN_IDS[0]);
    const fixture = createFixture([registration("v1")], { createRunId });

    await expect(
      fixture.runs.submit(
        { process: "test-processing", version: "v1", input: {} },
        { callerId: "caller-a", idempotencyKey: "invalid-business-input" },
      ),
    ).resolves.toMatchObject({
      accepted: false,
      error: { code: "INVALID_INPUT" },
    });
    await expect(
      fixture.runs.submit(
        { process: "missing", version: "v1", input: { value: "request" } },
        { callerId: "caller-a", idempotencyKey: "unknown-process" },
      ),
    ).resolves.toMatchObject({
      accepted: false,
      error: { code: "PROCESS_NOT_FOUND" },
    });
    await expect(
      fixture.runs.submit(
        {
          process: "test-processing",
          version: "v1",
          input: { value: "request" },
          attempts: 100,
        },
        { callerId: "caller-a", idempotencyKey: "invalid-envelope" },
      ),
    ).resolves.toMatchObject({
      accepted: false,
      error: { code: "INVALID_INPUT" },
    });

    expect(createRunId).not.toHaveBeenCalled();
    await expect(fixture.drain.drainOne()).resolves.toBe("empty");
  });

  it("replays caller-scoped idempotency and rejects conflicting reuse", async () => {
    const fixture = createFixture([registration("v1")]);
    const firstRequest = {
      process: "test-processing",
      version: "v1",
      input: { first: "ignored", value: " request " },
    };
    const acceptedRequest = request("v1", "request");

    const first = await fixture.runs.submit(firstRequest, {
      callerId: "caller-a",
      idempotencyKey: "shared-key",
    });
    const replay = await fixture.runs.submit(acceptedRequest, {
      callerId: "caller-a",
      idempotencyKey: "shared-key",
    });
    expect(replay).toEqual(first);
    await expect(
      fixture.runs.submit(request("v1", "different"), {
        callerId: "caller-a",
        idempotencyKey: "shared-key",
      }),
    ).resolves.toMatchObject({
      accepted: false,
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    const otherCaller = await fixture.runs.submit(acceptedRequest, {
      callerId: "caller-b",
      idempotencyKey: "shared-key",
    });
    expect(otherCaller).toMatchObject({ accepted: true, runId: RUN_IDS[3] });
    expect(
      await fixture.runs.find(RUN_IDS[0], caller("caller-b")),
    ).toBeUndefined();
    expect(
      await fixture.runs.find(RUN_IDS[3], caller("caller-a")),
    ).toBeUndefined();

    await expect(fixture.drain.drainOne()).resolves.toBe("processed");
    await expect(fixture.drain.drainOne()).resolves.toBe("processed");
    await expect(fixture.drain.drainOne()).resolves.toBe("empty");

    const terminalReplay = await fixture.runs.submit(acceptedRequest, {
      callerId: "caller-a",
      idempotencyKey: "shared-key",
    });
    expect(terminalReplay).toEqual(first);
    await expect(fixture.drain.drainOne()).resolves.toBe("empty");
  });

  it("uses one queue for exact registrations and ignores duplicate terminal jobs", async () => {
    const fixture = createFixture([
      registration("v1", async (value) => ({ value: `v1:${value}` })),
      registration("v2", async (value) => ({ value: `v2:${value}` })),
    ]);
    const first = await fixture.runs.submit(request("v1", "one"), {
      callerId: "caller-a",
      idempotencyKey: "one",
    });
    const second = await fixture.runs.submit(request("v2", "two"), {
      callerId: "caller-a",
      idempotencyKey: "two",
    });
    if (!first.accepted || !second.accepted) {
      throw new Error("Expected accepted Process Runs");
    }

    await expect(fixture.drain.drainOne()).resolves.toBe("processed");
    await expect(fixture.drain.drainOne()).resolves.toBe("processed");
    expect(await fixture.runs.find(first.runId, caller("caller-a"))).toMatchObject({
      status: "succeeded",
      output: { value: "v1:one" },
    });
    expect(await fixture.runs.find(second.runId, caller("caller-a"))).toMatchObject({
      status: "succeeded",
      output: { value: "v2:two" },
    });

    await fixture.queue.enqueue({ schemaVersion: 1, runId: first.runId });
    await expect(fixture.drain.drainOne()).resolves.toBe("ignored");
    expect(await fixture.runs.find(first.runId, caller("caller-a"))).toMatchObject({
      status: "succeeded",
      output: { value: "v1:one" },
    });
  });

  it("never exposes owner, accepted input, idempotency, or attempt state", async () => {
    const fixture = createFixture([registration("v1")]);
    const submission = await fixture.runs.submit(request("v1", "request"), {
      callerId: "caller-a",
      idempotencyKey: "private-key",
    });
    if (!submission.accepted) throw new Error("Expected accepted Process Run");

    const queued = await fixture.runs.find(submission.runId, caller("caller-a"));
    expect(Object.keys(queued ?? {}).sort()).toEqual(
      ["createdAt", "process", "runId", "status", "version"].sort(),
    );
    await fixture.drain.drainOne();
    const succeeded = await fixture.runs.find(
      submission.runId,
      caller("caller-a"),
    );
    expect(Object.keys(succeeded ?? {}).sort()).toEqual(
      [
        "createdAt",
        "finishedAt",
        "output",
        "process",
        "runId",
        "startedAt",
        "status",
        "version",
      ].sort(),
    );
  });
});

function createFixture(
  registrations: readonly ProcessRegistration[],
  options: { createRunId?: () => string } = {},
) {
  const store = createInMemoryProcessRunStore({ maxRuns: 20 });
  const queue = createInMemoryProcessWorkQueue({ maxJobs: 20 });
  const registry = createProcessRegistry(registrations);
  const runIds = [...RUN_IDS];
  const times = [
    "2026-08-09T10:00:00.000Z",
    "2026-08-09T10:00:01.000Z",
    "2026-08-09T10:00:02.000Z",
    "2026-08-09T10:00:03.000Z",
    "2026-08-09T10:00:04.000Z",
    "2026-08-09T10:00:05.000Z",
    "2026-08-09T10:00:06.000Z",
    "2026-08-09T10:00:07.000Z",
    "2026-08-09T10:00:08.000Z",
  ];
  const clock = () => {
    const time = times.shift();
    if (!time) throw new Error("Fixture clock exhausted");
    return time;
  };
  const runs = createAsyncProcessRuns({
    registry,
    store,
    queue,
    clock,
    createRunId:
      options.createRunId ??
      (() => {
        const id = runIds.shift();
        if (!id) throw new Error("Fixture run IDs exhausted");
        return id;
      }),
  });
  const worker = createProcessWorker({
    registry,
    store,
    attemptRunner: createProcessAttemptRunner(),
    clock,
    createClaimToken: () => "claim-token",
  });
  return {
    runs,
    queue,
    drain: createProcessWorkerDrain({ source: queue, worker }),
  };
}

function registration(
  version: string,
  execute: (value: string) => Promise<{ value: string }> = async (value) => ({
    value,
  }),
): ProcessRegistration {
  return defineProcessRegistration({
    id: "test-processing",
    version,
    inputSchema: z
      .object({ value: z.string() })
      .transform((input) => ({ value: input.value.trim() })),
    outputSchema: z.strictObject({ value: z.string() }),
    execute: async (input) => execute(input.value),
  });
}

function request(version: string, value: string) {
  return { process: "test-processing", version, input: { value } };
}

function caller(callerId: string) {
  return { callerId };
}

const RUN_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
] as const;
