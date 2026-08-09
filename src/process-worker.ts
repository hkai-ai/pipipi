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
  process: (
    job: unknown,
    context?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<ProcessWorkResult>;
  releaseActive: (request: { releasedAt: string }) => Promise<number>;
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
  const activeClaims = new Map<
    string,
    Readonly<{ runId: string; claimToken: string }>
  >();

  return Object.freeze({
    process: async (rawJob, context) => {
      const job = parseProcessWorkJob(rawJob);
      if (!job) return "invalid-job";
      if (context?.signal?.aborted) return "ignored";

      const claim = await options.store.claim({
        runId: job.runId,
        claimToken: createClaimToken(),
        claimedAt: clock(),
      });
      if (!claim) return "ignored";
      activeClaims.set(claim.claimToken, {
        runId: claim.runId,
        claimToken: claim.claimToken,
      });

      try {
        if (context?.signal?.aborted) {
          await options.store.releaseClaim({
            runId: claim.runId,
            claimToken: claim.claimToken,
            releasedAt: clock(),
          });
          return "ignored";
        }
        const registration = options.registry.find({
          id: claim.process,
          version: claim.version,
        });
        const result: ProcessRunResult = registration
          ? await options.attemptRunner.run({
              runId: claim.runId,
              registration,
              acceptedInput: claim.acceptedInput,
              signal: context?.signal,
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

        if (context?.signal?.aborted) {
          await options.store.releaseClaim({
            runId: claim.runId,
            claimToken: claim.claimToken,
            releasedAt: clock(),
          });
          return "ignored";
        }

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
      } finally {
        activeClaims.delete(claim.claimToken);
      }
    },

    releaseActive: async (request) => {
      const claims = [...activeClaims.values()];
      const released = await Promise.all(
        claims.map((claim) =>
          options.store.releaseClaim({
            runId: claim.runId,
            claimToken: claim.claimToken,
            releasedAt: request.releasedAt,
          }),
        ),
      );
      return released.filter(Boolean).length;
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
