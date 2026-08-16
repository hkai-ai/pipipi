import {
    createProcessRunAttemptLog,
    type ProcessRunLogClock,
    type ProcessRunLogSink,
} from "./logging.js";
import type {
    AcceptedProcessInput,
    JsonValue,
    ProcessRegistration,
} from "./registration.js";
import { type ProcessRunResult, processFailure } from "./result.js";

export type ProcessAttemptRequest = Readonly<{
    runId: string;
    registration: ProcessRegistration;
    acceptedInput: AcceptedProcessInput;
    attemptNumber?: number;
    signal?: AbortSignal;
    captureEvaluation?: (value: JsonValue) => void;
}>;

export type ProcessAttemptRunner = Readonly<{
    run: (attempt: ProcessAttemptRequest) => Promise<ProcessRunResult>;
}>;

export function createProcessAttemptRunner(
    options: {
        processTimeoutMs?: number;
        logSink?: ProcessRunLogSink;
        logClock?: ProcessRunLogClock;
    } = {},
): ProcessAttemptRunner {
    const processTimeoutMs = options.processTimeoutMs ?? 30_000;
    if (!Number.isInteger(processTimeoutMs) || processTimeoutMs < 1) {
        throw new Error("Process timeout must be a positive integer");
    }

    return Object.freeze({
        run: async (attempt): Promise<ProcessRunResult> => {
            const identity = {
                process: attempt.registration.identity.id,
                version: attempt.registration.identity.version,
            };
            const attemptNumber = attempt.attemptNumber ?? 1;
            if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
                throw new Error("Process Attempt number must be positive");
            }
            const controller = new AbortController();
            const log = createProcessRunAttemptLog({
                runId: attempt.runId,
                ...identity,
                attemptNumber,
                signal: controller.signal,
                sink: options.logSink,
                clock: options.logClock,
            });
            let timeout: NodeJS.Timeout | undefined;
            let externallyCancelled = false;
            let removeCancellationListener: (() => void) | undefined;
            const timeoutFailure = new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                    controller.abort();
                    reject(new ProcessTimeoutFailure());
                }, processTimeoutMs);
            });
            const cancellationFailure = new Promise<never>(
                (_resolve, reject) => {
                    const cancel = () => {
                        externallyCancelled = true;
                        controller.abort(attempt.signal?.reason);
                        reject(new ProcessAttemptCancelledFailure());
                    };
                    if (attempt.signal?.aborted) {
                        cancel();
                        return;
                    }
                    attempt.signal?.addEventListener("abort", cancel, {
                        once: true,
                    });
                    removeCancellationListener = () =>
                        attempt.signal?.removeEventListener("abort", cancel);
                },
            );

            try {
                const completion = await Promise.race([
                    attempt.registration.run(attempt.acceptedInput, {
                        runId: attempt.runId,
                        signal: controller.signal,
                        runActivity: log.runActivity,
                        ...(attempt.captureEvaluation
                            ? {
                                  captureEvaluation: attempt.captureEvaluation,
                              }
                            : {}),
                    }),
                    timeoutFailure,
                    cancellationFailure,
                ]);
                const result: ProcessRunResult =
                    completion.status === "succeeded"
                        ? {
                              runId: attempt.runId,
                              ...identity,
                              status: "succeeded",
                              output: completion.output,
                          }
                        : processFailure(
                              attempt.runId,
                              completion.error.code,
                              completion.error.publicMessage,
                              identity,
                          );
                log.finish(
                    result.status === "succeeded"
                        ? { outcome: "succeeded" }
                        : {
                              outcome: "failed",
                              errorCode: result.error.code,
                          },
                );
                return result;
            } catch (error) {
                if (
                    externallyCancelled ||
                    error instanceof ProcessAttemptCancelledFailure
                ) {
                    const result = processFailure(
                        attempt.runId,
                        "INTERNAL_ERROR",
                        "The process could not be completed",
                        identity,
                    );
                    log.finish({
                        outcome: "cancelled",
                        errorCode: "INTERNAL_ERROR",
                    });
                    return result;
                }
                if (
                    controller.signal.aborted ||
                    error instanceof ProcessTimeoutFailure
                ) {
                    const result = processFailure(
                        attempt.runId,
                        "PROCESS_TIMEOUT",
                        "The process exceeded its time limit",
                        identity,
                    );
                    log.finish({
                        outcome: "timed_out",
                        errorCode: "PROCESS_TIMEOUT",
                    });
                    return result;
                }
                const result = processFailure(
                    attempt.runId,
                    "INTERNAL_ERROR",
                    "The process could not be completed",
                    identity,
                );
                log.finish({
                    outcome: "failed",
                    errorCode: "INTERNAL_ERROR",
                });
                return result;
            } finally {
                if (timeout) clearTimeout(timeout);
                removeCancellationListener?.();
            }
        },
    });
}

class ProcessTimeoutFailure extends Error {}

class ProcessAttemptCancelledFailure extends Error {}
