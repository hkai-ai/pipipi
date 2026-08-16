import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createProcessAttemptRunner } from "./attempt.js";
import type { ProcessRunLogClock, ProcessRunLogSink } from "./logging.js";
import {
    disabledProcessRunRecords,
    type ProcessRunRecords,
} from "./records.js";
import type {
    JsonValue,
    ProcessRegistrationAcceptance,
} from "./registration.js";
import { type ProcessRegistry, processRegistryBrand } from "./registry.js";
import { type ProcessRunResult, processFailure } from "./result.js";

const executeRequestSchema = z.strictObject({
    process: z.string().min(1),
    version: z.string().min(1),
    input: z.unknown(),
});

const requestIdentitySchema = z.object({
    process: z.string(),
    version: z.string(),
});

export type ProcessExecutor = Readonly<{
    execute: (request: unknown) => Promise<ProcessRunResult>;
    evaluate?: (request: unknown) => Promise<ProcessEvaluationResult>;
}>;

export type ProcessEvaluationResult = Readonly<{
    result: ProcessRunResult;
    evaluation?: JsonValue;
}>;

export function createProcessRunner(options: {
    registry: ProcessRegistry;
    processTimeoutMs?: number;
    runRecords?: ProcessRunRecords;
    runLogSink?: ProcessRunLogSink;
    runLogClock?: ProcessRunLogClock;
}): ProcessExecutor {
    const registry = options.registry;
    if (
        typeof registry !== "object" ||
        registry === null ||
        registry[processRegistryBrand] !== true
    ) {
        throw new Error("Process Runner requires a Process Registry");
    }
    const runRecords = options.runRecords ?? disabledProcessRunRecords;
    const attemptRunner = createProcessAttemptRunner({
        processTimeoutMs: options.processTimeoutMs,
        logSink: options.runLogSink,
        logClock: options.runLogClock,
    });

    const execute = async (
        rawRequest: unknown,
        captureEvaluation?: (value: JsonValue) => void,
    ): Promise<ProcessRunResult> => {
        const runId = randomUUID();
        const requestResult = executeRequestSchema.safeParse(rawRequest);
        if (!requestResult.success) {
            const identity = requestIdentitySchema.safeParse(rawRequest);
            return completeProcessRun(
                runRecords,
                processFailure(
                    runId,
                    "INVALID_INPUT",
                    "The process input is invalid",
                    {
                        ...(identity.success ? identity.data : {}),
                    },
                ),
            );
        }

        const request = requestResult.data;
        const identity = {
            process: request.process,
            version: request.version,
        };
        const registration = registry.find({
            id: request.process,
            version: request.version,
        });
        if (!registration) {
            return completeProcessRun(
                runRecords,
                processFailure(
                    runId,
                    "PROCESS_NOT_FOUND",
                    "The requested process version is not registered",
                    identity,
                ),
            );
        }

        let acceptance: ProcessRegistrationAcceptance;
        try {
            acceptance = registration.accept(request.input);
        } catch {
            return completeProcessRun(
                runRecords,
                processFailure(
                    runId,
                    "INTERNAL_ERROR",
                    "The process could not be completed",
                    identity,
                ),
            );
        }

        if (!acceptance.accepted) {
            return completeProcessRun(
                runRecords,
                processFailure(
                    runId,
                    "INVALID_INPUT",
                    "The process input is invalid",
                    identity,
                ),
            );
        }

        const result = await attemptRunner.run({
            runId,
            registration,
            acceptedInput: acceptance.acceptedInput,
            ...(captureEvaluation ? { captureEvaluation } : {}),
        });

        return completeProcessRun(runRecords, result, {
            input: request.input,
        });
    };

    return Object.freeze({
        execute: (request: unknown) => execute(request),
        evaluate: async (
            request: unknown,
        ): Promise<ProcessEvaluationResult> => {
            let evaluation: JsonValue | undefined;
            const result = await execute(request, (value) => {
                evaluation = value;
            });
            return Object.freeze({
                result,
                ...(evaluation === undefined ? {} : { evaluation }),
            });
        },
    });
}

function completeProcessRun(
    runRecords: ProcessRunRecords,
    result: ProcessRunResult,
    acceptedRequest?: { input: unknown },
): ProcessRunResult {
    try {
        const recording = runRecords.record({
            result,
            ...(acceptedRequest ? { acceptedRequest } : {}),
        });
        if (recording) void recording.catch(() => {});
    } catch {
        // Run recording is best-effort and cannot change the process result.
    }
    return result;
}
