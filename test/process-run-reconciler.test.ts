import { describe, expect, it, vi } from "vitest";
import { createProcessRunReconciler } from "../src/process-run-reconciler.js";
import type { ProcessRunStore } from "../src/process-run-store.js";
import type { ProcessWorkQueue } from "../src/process-work-queue.js";

describe("Process Run Reconciler", () => {
  it("redelivers old queued and expired running candidates as minimal jobs", async () => {
    const findRecoverable = vi.fn(async () => [
      { runId: runId(1) },
      { runId: runId(2) },
    ]);
    const enqueue = vi
      .fn<ProcessWorkQueue["enqueue"]>()
      .mockResolvedValueOnce("enqueued")
      .mockResolvedValueOnce("duplicate");
    const reconciler = createProcessRunReconciler({
      store: fakeStore({ findRecoverable }),
      queue: fakeQueue({ enqueue }),
      queuedAgeMs: 60_000,
      batchSize: 10,
      clock: () => "2026-08-09T10:01:00.000Z",
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual({
      found: 2,
      enqueued: 1,
      duplicates: 1,
      failed: 0,
    });
    expect(findRecoverable).toHaveBeenCalledWith({
      asOf: "2026-08-09T10:01:00.000Z",
      queuedBefore: "2026-08-09T10:00:00.000Z",
      limit: 10,
    });
    expect(enqueue.mock.calls).toEqual([
      [{ schemaVersion: 1, runId: runId(1) }],
      [{ schemaVersion: 1, runId: runId(2) }],
    ]);
  });

  it("isolates one queue failure and continues the batch", async () => {
    const reconciler = createProcessRunReconciler({
      store: fakeStore({
        findRecoverable: async () => [
          { runId: runId(3) },
          { runId: runId(4) },
        ],
      }),
      queue: fakeQueue({
        enqueue: async (job) => {
          if (job.runId === runId(3)) throw new Error("Redis unavailable");
          return "enqueued";
        },
      }),
      clock: () => "2026-08-09T10:01:00.000Z",
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual({
      found: 2,
      enqueued: 1,
      duplicates: 0,
      failed: 1,
    });
  });

  it("rejects unsafe bounds", () => {
    expect(() =>
      createProcessRunReconciler({
        store: fakeStore(),
        queue: fakeQueue(),
        queuedAgeMs: 0,
      }),
    ).toThrow("Queued Process Run recovery age must be a positive safe integer");
    expect(() =>
      createProcessRunReconciler({
        store: fakeStore(),
        queue: fakeQueue(),
        batchSize: 101,
      }),
    ).toThrow("Process Run reconciliation batch size must not exceed 100");
  });
});

function fakeStore(overrides: Partial<ProcessRunStore> = {}): ProcessRunStore {
  return {
    accept: async () => {
      throw new Error("unused");
    },
    findOwned: async () => undefined,
    claim: async () => undefined,
    complete: async () => false,
    scheduleRetry: async () => false,
    releaseClaim: async () => false,
    findRecoverable: async () => [],
    ...overrides,
  };
}

function fakeQueue(overrides: Partial<ProcessWorkQueue> = {}): ProcessWorkQueue {
  return {
    enqueue: async () => "enqueued",
    close: async () => undefined,
    ...overrides,
  };
}

function runId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
