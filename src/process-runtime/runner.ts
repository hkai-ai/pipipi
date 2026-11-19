/** 校验并执行版本化 Process，将调用方归属与 400 校验明细写入运行观测，对外提供执行和评测入口。 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    resolveTemplateMasterAcceptedInput,
    type TemplateMasterSourceRunLookup,
} from "../processes/template-master/source-run.js";
import { createProcessAttemptRunner } from "./attempt.js";
import {
    extractRequestIdentity,
    formatValidationErrorMessage,
    formatZodValidationDetails,
    type ProcessRunFailureDetail,
} from "./input-validation.js";
import { startLocalTrace } from "./local-trace.js";
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

export type ProcessExecutorCaller = {
    callerId?: string;
    authMethod?: "api_key" | "gateway" | "anonymous";
    traceId?: string;
};

export type ProcessExecutor = Readonly<{
    execute: (
        request: unknown,
        caller?: ProcessExecutorCaller,
    ) => Promise<ProcessRunResult>;
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
    sourceRunLookup?: TemplateMasterSourceRunLookup;
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
        caller?: ProcessExecutorCaller,
    ): Promise<ProcessRunResult> => {
        const complete = (
            records: ProcessRunRecords,
            result: ProcessRunResult,
            acceptedRequest?: { input: unknown },
            failureDetail?: ProcessRunFailureDetail,
        ) =>
            completeProcessRun(
                records,
                result,
                acceptedRequest,
                caller,
                failureDetail,
            );
        const runId = randomUUID();
        const requestResult = executeRequestSchema.safeParse(rawRequest);
        if (!requestResult.success) {
            const identity = extractRequestIdentity(rawRequest);
            const details =
                rawRequest === undefined
                    ? Object.freeze([
                          Object.freeze({
                              path: "/",
                              keyword: "type",
                              message: "must be a valid JSON object",
                          }),
                      ])
                    : formatZodValidationDetails(
                          requestResult.error,
                          rawRequest,
                      );
            const message = formatValidationErrorMessage({
                ...identity,
                details,
            });
            return complete(
                runRecords,
                processFailure(
                    runId,
                    "INVALID_INPUT",
                    message,
                    identity,
                    details,
                ),
                undefined,
                {
                    httpStatus: 400,
                    endpoint: "/execute",
                    ...(caller?.traceId ? { traceId: caller.traceId } : {}),
                    message,
                    details,
                },
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
            return complete(
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
            return complete(
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
            const details = acceptance.details;
            const message = formatValidationErrorMessage({
                ...identity,
                details,
            });
            return complete(
                runRecords,
                processFailure(
                    runId,
                    "INVALID_INPUT",
                    message,
                    identity,
                    details,
                ),
                undefined,
                {
                    httpStatus: 400,
                    endpoint: "/execute",
                    ...(caller?.traceId ? { traceId: caller.traceId } : {}),
                    message,
                    ...(details ? { details } : {}),
                },
            );
        }

        const resolved = await resolveTemplateMasterAcceptedInput(
            acceptance.acceptedInput,
            { callerId: caller?.callerId },
            options.sourceRunLookup,
        );
        if (!resolved.ok) {
            return complete(
                runRecords,
                processFailure(
                    runId,
                    resolved.code,
                    resolved.message,
                    identity,
                    resolved.details,
                ),
                undefined,
                {
                    httpStatus: 400,
                    endpoint: "/execute",
                    ...(caller?.traceId ? { traceId: caller.traceId } : {}),
                    message: resolved.message,
                    details: resolved.details,
                },
            );
        }

        startLocalTrace({ runId, ...identity });
        const result = await attemptRunner.run({
            runId,
            registration,
            acceptedInput: resolved.acceptedInput,
            ...(captureEvaluation ? { captureEvaluation } : {}),
        });

        return complete(runRecords, result, {
            input:
                resolved.acceptedInput === acceptance.acceptedInput
                    ? request.input
                    : resolved.acceptedInput.input,
        });
    };

    return Object.freeze({
        execute: (request, caller) => execute(request, undefined, caller),
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
    caller?: ProcessExecutorCaller,
    failureDetail?: ProcessRunFailureDetail,
): ProcessRunResult {
    try {
        const recording = runRecords.record({
            result,
            ...(caller?.callerId ? { callerId: caller.callerId } : {}),
            ...(caller?.authMethod ? { authMethod: caller.authMethod } : {}),
            ...(acceptedRequest ? { acceptedRequest } : {}),
            ...(failureDetail ? { failureDetail } : {}),
        });
        if (recording) void recording.catch(() => {});
    } catch {
        // Run recording is best-effort and cannot change the process result.
    }
    return result;
}
