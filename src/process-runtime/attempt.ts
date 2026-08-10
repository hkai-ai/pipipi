import type {
    AcceptedProcessInput,
    ProcessRegistration,
} from "./registration.js";
import { type ProcessRunResult, processFailure } from "./result.js";

export type ProcessAttemptRequest = Readonly<{
    runId: string;
    registration: ProcessRegistration;
    acceptedInput: AcceptedProcessInput;
    signal?: AbortSignal;
}>;

export type ProcessAttemptRunner = Readonly<{
    run: (attempt: ProcessAttemptRequest) => Promise<ProcessRunResult>;
}>;

export function createProcessAttemptRunner(
    options: { processTimeoutMs?: number } = {},
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
            const controller = new AbortController();
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
                    }),
                    timeoutFailure,
                    cancellationFailure,
                ]);
                return completion.status === "succeeded"
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
            } catch (error) {
                if (
                    externallyCancelled ||
                    error instanceof ProcessAttemptCancelledFailure
                ) {
                    return processFailure(
                        attempt.runId,
                        "INTERNAL_ERROR",
                        "The process could not be completed",
                        identity,
                    );
                }
                if (
                    controller.signal.aborted ||
                    error instanceof ProcessTimeoutFailure
                ) {
                    return processFailure(
                        attempt.runId,
                        "PROCESS_TIMEOUT",
                        "The process exceeded its time limit",
                        identity,
                    );
                }
                return processFailure(
                    attempt.runId,
                    "INTERNAL_ERROR",
                    "The process could not be completed",
                    identity,
                );
            } finally {
                if (timeout) clearTimeout(timeout);
                removeCancellationListener?.();
            }
        },
    });
}

class ProcessTimeoutFailure extends Error {}

class ProcessAttemptCancelledFailure extends Error {}
