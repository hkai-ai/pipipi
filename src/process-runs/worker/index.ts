import { randomUUID } from "node:crypto";
import type {
    ProcessAttemptRunner,
    ProcessErrorCode,
    ProcessRegistration,
    ProcessRegistry,
    ProcessRunResult,
} from "../../process-runtime/index.js";
import {
    type AsyncOperationalLogSink,
    emitAsyncOperationalLog,
    tryOperationalTimestamp,
} from "../ops/logging.js";
import { type ProcessWorkSource, parseProcessWorkJob } from "../queue/index.js";
import type { ProcessRunStore } from "../store/index.js";

export type ProcessWorkResult =
    | "processed"
    | "ignored"
    | "invalid-job"
    | Readonly<{ outcome: "retry-scheduled"; delayMs: number }>;

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
    logSink?: AsyncOperationalLogSink;
    logClock?: () => string;
}): ProcessWorker {
    const clock = options.clock ?? (() => new Date().toISOString());
    const createClaimToken = options.createClaimToken ?? randomUUID;
    const logClock = options.logClock ?? (() => new Date().toISOString());
    const activeClaims = new Map<
        string,
        Readonly<{ runId: string; claimToken: string }>
    >();

    return Object.freeze({
        process: async (rawJob, context) => {
            const job = parseProcessWorkJob(rawJob);
            if (!job) return "invalid-job";
            if (context?.signal?.aborted) {
                logProcessWork(options.logSink, logClock, job.runId, "ignored");
                return "ignored";
            }

            const claim = await options.store.claim({
                runId: job.runId,
                claimToken: createClaimToken(),
                claimedAt: clock(),
            });
            if (!claim) {
                logProcessWork(options.logSink, logClock, job.runId, "ignored");
                return "ignored";
            }
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
                    logProcessWork(
                        options.logSink,
                        logClock,
                        claim.runId,
                        "ignored",
                        claim.attemptNumber,
                    );
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
                          attemptNumber: claim.attemptNumber,
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
                    logProcessWork(
                        options.logSink,
                        logClock,
                        claim.runId,
                        "ignored",
                        claim.attemptNumber,
                    );
                    return "ignored";
                }

                if (
                    registration &&
                    result.status === "failed" &&
                    shouldRetry(
                        registration.retryPolicy,
                        result.error.code,
                        claim.attemptNumber,
                    )
                ) {
                    const scheduled = await options.store.scheduleRetry({
                        runId: claim.runId,
                        claimToken: claim.claimToken,
                        scheduledAt: clock(),
                        failure: result.error,
                    });
                    const outcome: ProcessWorkResult = scheduled
                        ? {
                              outcome: "retry-scheduled",
                              delayMs: retryDelay(
                                  registration.retryPolicy,
                                  claim.attemptNumber,
                              ),
                          }
                        : "ignored";
                    logProcessWork(
                        options.logSink,
                        logClock,
                        claim.runId,
                        scheduled ? "retry_scheduled" : "ignored",
                        claim.attemptNumber,
                    );
                    return outcome;
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
                const outcome = completed ? "processed" : "ignored";
                logProcessWork(
                    options.logSink,
                    logClock,
                    claim.runId,
                    outcome,
                    claim.attemptNumber,
                );
                return outcome;
            } catch (error) {
                logProcessWork(
                    options.logSink,
                    logClock,
                    claim.runId,
                    "worker_error",
                    claim.attemptNumber,
                );
                throw error;
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

function logProcessWork(
    sink: AsyncOperationalLogSink | undefined,
    clock: () => string,
    runId: string,
    outcome: "processed" | "ignored" | "retry_scheduled" | "worker_error",
    attemptNumber?: number,
): void {
    const timestamp = tryOperationalTimestamp(clock);
    if (!timestamp) return;
    emitAsyncOperationalLog(sink, {
        event: "process_run_work_finished",
        timestamp,
        runId,
        ...(attemptNumber === undefined ? {} : { attemptNumber }),
        outcome,
    });
}

function shouldRetry(
    policy: ProcessRegistration["retryPolicy"],
    errorCode: ProcessErrorCode,
    attemptNumber: number,
): boolean {
    return (
        attemptNumber < policy.maximumAttempts &&
        policy.retryableErrorCodes.some((code) => code === errorCode)
    );
}

function retryDelay(
    policy: ProcessRegistration["retryPolicy"],
    attemptNumber: number,
): number {
    return Math.min(
        policy.backoff.initialDelayMs * 2 ** (attemptNumber - 1),
        policy.backoff.maximumDelayMs,
    );
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
