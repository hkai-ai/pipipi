import { randomUUID } from "node:crypto";
import type {
  ProcessAttemptRunner,
  ProcessRegistry,
  ProcessRunResult,
} from "./process-runtime.js";
import type { ProcessRunStore } from "./process-run-store.js";
import {
  parseProcessWorkJob,
  type ProcessWorkSource,
} from "./process-work-queue.js";

export type ProcessWorkResult = "processed" | "ignored" | "invalid-job";

export type ProcessWorker = Readonly<{
  process: (job: unknown) => Promise<ProcessWorkResult>;
}>;

export function createProcessWorker(options: {
  registry: ProcessRegistry;
  store: ProcessRunStore;
  attemptRunner: ProcessAttemptRunner;
  clock?: () => string;
  createClaimToken?: () => string;
}): ProcessWorker {
  const clock = options.clock ?? (() => new Date().toISOString());
  const createClaimToken = options.createClaimToken ?? randomUUID;

  return Object.freeze({
    process: async (rawJob) => {
      const job = parseProcessWorkJob(rawJob);
      if (!job) return "invalid-job";

      const claim = await options.store.claim({
        runId: job.runId,
        claimToken: createClaimToken(),
        claimedAt: clock(),
      });
      if (!claim) return "ignored";

      const registration = options.registry.find({
        id: claim.process,
        version: claim.version,
      });
      const result: ProcessRunResult = registration
        ? await options.attemptRunner.run({
            runId: claim.runId,
            registration,
            acceptedInput: claim.acceptedInput,
          })
        : {
            runId: claim.runId,
            process: claim.process,
            version: claim.version,
            status: "failed",
            error: {
              code: "INTERNAL_ERROR",
              message: "The process could not be completed",
            },
          };

      const completed = await options.store.complete({
        runId: claim.runId,
        claimToken: claim.claimToken,
        completedAt: clock(),
        completion:
          result.status === "succeeded"
            ? { status: "succeeded", output: result.output }
            : { status: "failed", error: result.error },
      });
      return completed ? "processed" : "ignored";
    },
  });
}

export type ProcessWorkerDrain = Readonly<{
  drainOne: () => Promise<ProcessWorkResult | "empty">;
}>;

export function createProcessWorkerDrain(options: {
  source: ProcessWorkSource;
  worker: ProcessWorker;
}): ProcessWorkerDrain {
  return Object.freeze({
    drainOne: async () => {
      const job = await options.source.take();
      return job ? options.worker.process(job) : "empty";
    },
  });
}
