import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostgresRetentionCleanup } from "../src/runs/postgres-retention.js";
import {
  createRetentionCleaner,
  createRetentionCleanerRuntime,
  type RetentionCleaner,
} from "../src/runs/retention.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Retention Cleaner", () => {
  it("uses one cutoff across bounded batches and returns a resumable cursor", async () => {
    const cleanupBatch = vi
      .fn<PostgresRetentionCleanup["cleanupBatch"]>()
      .mockResolvedValueOnce(batch({ examined: 2, nextCursor: RUN_IDS[0] }))
      .mockResolvedValueOnce(batch({ examined: 2, nextCursor: RUN_IDS[1] }))
      .mockResolvedValueOnce(batch({ examined: 1, runsDeleted: 1 }));
    const cleaner = createRetentionCleaner({
      cleanup: { cleanupBatch, ready: async () => undefined },
      batchSize: 2,
      maximumBatchesPerSweep: 2,
    });

    const first = await cleaner.runSweep({ asOf: AS_OF });
    expect(first).toEqual({
      asOf: AS_OF,
      batches: 2,
      examined: 4,
      inputContentsDeleted: 0,
      resultsDeleted: 0,
      deliveryAttemptsDeleted: 0,
      runsDeleted: 0,
      deferredRuns: 0,
      completed: false,
      nextCursor: RUN_IDS[1],
    });
    await expect(
      cleaner.runSweep({ asOf: first.asOf, cursor: first.nextCursor }),
    ).resolves.toMatchObject({
      asOf: AS_OF,
      batches: 1,
      examined: 1,
      runsDeleted: 1,
      completed: true,
    });
    expect(cleanupBatch.mock.calls).toEqual([
      [{ asOf: AS_OF, batchSize: 2 }],
      [{ asOf: AS_OF, batchSize: 2, cursor: RUN_IDS[0] }],
      [{ asOf: AS_OF, batchSize: 2, cursor: RUN_IDS[1] }],
    ]);
  });

  it("stops at a committed batch boundary when aborted", async () => {
    const controller = new AbortController();
    const cleanupBatch = vi
      .fn<PostgresRetentionCleanup["cleanupBatch"]>()
      .mockResolvedValue(batch({ examined: 1, nextCursor: RUN_IDS[0] }));
    const cleaner = createRetentionCleaner({
      cleanup: { cleanupBatch, ready: async () => undefined },
      onBatch: () => controller.abort(),
    });

    await expect(
      cleaner.runSweep({ asOf: AS_OF, signal: controller.signal }),
    ).resolves.toMatchObject({
      batches: 1,
      completed: false,
      nextCursor: RUN_IDS[0],
    });
    expect(cleanupBatch).toHaveBeenCalledOnce();
  });

  it("keeps a periodic continuation and closes resources once", async () => {
    vi.useFakeTimers();
    const runSweep = vi
      .fn<RetentionCleaner["runSweep"]>()
      .mockResolvedValueOnce(
        sweep({ completed: false, nextCursor: RUN_IDS[0] }),
      )
      .mockResolvedValueOnce(sweep({ completed: true }));
    const databaseReady = vi.fn(async () => undefined);
    const closeResources = vi.fn(async () => undefined);
    const onResult = vi.fn();
    const runtime = createRetentionCleanerRuntime({
      cleaner: { runSweep },
      databaseReady,
      closeResources,
      intervalMs: 100,
      onResult,
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runSweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(runSweep).toHaveBeenCalledTimes(2);
    expect(runSweep.mock.calls[1]?.[0]).toMatchObject({
      asOf: AS_OF,
      cursor: RUN_IDS[0],
    });
    await runtime.ready();
    expect(databaseReady).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledTimes(2);

    await runtime.close();
    await runtime.close();
    expect(closeResources).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSweep).toHaveBeenCalledTimes(2);
  });

  it("validates bounds before any cleanup starts", () => {
    expect(() =>
      createRetentionCleaner({
        cleanup: idleCleanup(),
        batchSize: 101,
      }),
    ).toThrow("Retention cleanup batch size must not exceed 100");
    expect(() =>
      createRetentionCleanerRuntime({
        cleaner: { runSweep: async () => sweep({ completed: true }) },
        databaseReady: async () => undefined,
        closeResources: async () => undefined,
        intervalMs: 0,
      }),
    ).toThrow("Retention cleanup interval must be a positive safe integer");
  });
});

function idleCleanup(): PostgresRetentionCleanup {
  return {
    cleanupBatch: async () => batch({}),
    ready: async () => undefined,
  };
}

function batch(
  overrides: Partial<
    Awaited<ReturnType<PostgresRetentionCleanup["cleanupBatch"]>>
  >,
) {
  return {
    examined: 0,
    inputContentsDeleted: 0,
    resultsDeleted: 0,
    deliveryAttemptsDeleted: 0,
    runsDeleted: 0,
    deferredRuns: 0,
    ...overrides,
  };
}

function sweep(
  overrides: Partial<Awaited<ReturnType<RetentionCleaner["runSweep"]>>>,
) {
  return {
    asOf: AS_OF,
    batches: 1,
    examined: 0,
    inputContentsDeleted: 0,
    resultsDeleted: 0,
    deliveryAttemptsDeleted: 0,
    runsDeleted: 0,
    deferredRuns: 0,
    completed: true,
    ...overrides,
  };
}

const AS_OF = "2026-08-09T10:00:00.000Z";
const RUN_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
] as const;
