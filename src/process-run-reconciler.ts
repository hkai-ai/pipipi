import type { ProcessRunStore } from "./process-run-store.js";
import type { ProcessWorkQueue } from "./process-work-queue.js";

export type ProcessRunReconciliationResult = Readonly<{
  found: number;
  enqueued: number;
  duplicates: number;
  failed: number;
}>;

export type ProcessRunReconciler = Readonly<{
  reconcileOnce: () => Promise<ProcessRunReconciliationResult>;
}>;

export function createProcessRunReconciler(options: {
  store: ProcessRunStore;
  queue: ProcessWorkQueue;
  queuedAgeMs?: number;
  batchSize?: number;
  clock?: () => string;
}): ProcessRunReconciler {
  const queuedAgeMs = positiveInteger(
    options.queuedAgeMs ?? 60_000,
    "Queued Process Run recovery age",
  );
  const batchSize = positiveInteger(
    options.batchSize ?? 25,
    "Process Run reconciliation batch size",
  );
  if (batchSize > 100) {
    throw new Error("Process Run reconciliation batch size must not exceed 100");
  }
  const clock = options.clock ?? (() => new Date().toISOString());

  return Object.freeze({
    reconcileOnce: async () => {
      const asOf = clock();
      const candidates = await options.store.findRecoverable({
        asOf,
        queuedBefore: subtractMilliseconds(asOf, queuedAgeMs),
        limit: batchSize,
      });
      let enqueued = 0;
      let duplicates = 0;
      let failed = 0;

      for (const candidate of candidates) {
        try {
          const result = await options.queue.enqueue({
            schemaVersion: 1,
            runId: candidate.runId,
          });
          if (result === "enqueued") enqueued += 1;
          else duplicates += 1;
        } catch {
          failed += 1;
        }
      }

      return Object.freeze({
        found: candidates.length,
        enqueued,
        duplicates,
        failed,
      });
    },
  });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function subtractMilliseconds(timestamp: string, durationMs: number): string {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    throw new Error("Process Run reconciliation timestamp is invalid");
  }
  return new Date(time - durationMs).toISOString();
}
