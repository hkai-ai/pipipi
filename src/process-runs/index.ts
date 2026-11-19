/** 异步提交、owner 隔离、caller-scoped idempotency 和公共状态投影 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
    extractRequestIdentity,
    formatValidationErrorMessage,
    formatZodValidationDetails,
    type InputValidationDetail,
    type ProcessErrorCode,
    type ProcessRegistry,
    type RunCost,
    runCostFromSnapshot,
    type SourceRunErrorCode,
} from "../process-runtime/index.js";
import {
    resolveTemplateMasterAcceptedInput,
    type TemplateMasterSourceRunLookup,
} from "../processes/template-master/source-run.js";
import type { ProcessWorkQueue } from "./queue/index.js";
import {
    type ProcessRunAcceptance,
    ProcessRunBacklogLimitError,
    type ProcessRunStore,
    type StoredProcessRun,
} from "./store/index.js";

const processRunRequestSchema = z.strictObject({
    process: z.string().min(1),
    version: z.string().min(1),
    input: z.unknown(),
});

export type ProcessRunView =
    | Readonly<{
          runId: string;
          process: string;
          version: string;
          status: "queued";
          createdAt: string;
      }>
    | Readonly<{
          runId: string;
          process: string;
          version: string;
          status: "running";
          createdAt: string;
          startedAt: string;
      }>
    | Readonly<{
          runId: string;
          process: string;
          version: string;
          status: "succeeded";
          createdAt: string;
          startedAt: string;
          finishedAt: string;
          /** 本次运行（含重试）的已知费用，口径同 /execute；无已知费用时省略。 */
          cost?: RunCost;
          output: unknown;
      }>
    | Readonly<{
          runId: string;
          process: string;
          version: string;
          status: "succeeded";
          createdAt: string;
          startedAt: string;
          finishedAt: string;
          /** 本次运行（含重试）的已知费用，口径同 /execute；无已知费用时省略。 */
          cost?: RunCost;
          resultAvailability: "expired";
          resultExpiredAt: string;
      }>
    | Readonly<{
          runId: string;
          process: string;
          version: string;
          status: "failed";
          createdAt: string;
          startedAt: string;
          finishedAt: string;
          /** 本次运行（含重试）的已知费用，口径同 /execute；无已知费用时省略。 */
          cost?: RunCost;
          error: Readonly<{
              code: ProcessErrorCode;
              message: string;
          }>;
      }>
    | Readonly<{
          runId: string;
          process: string;
          version: string;
          status: "failed";
          createdAt: string;
          startedAt: string;
          finishedAt: string;
          /** 本次运行（含重试）的已知费用，口径同 /execute；无已知费用时省略。 */
          cost?: RunCost;
          resultAvailability: "expired";
          resultExpiredAt: string;
      }>;

export type ProcessRunSubmission =
    | Readonly<{
          accepted: true;
          runId: string;
          process: string;
          version: string;
          /**
           * The run's real status. A first submission is always `queued`, but an
           * idempotent replay reports whatever the existing run has reached, so
           * callers are never told a finished run is still waiting.
           */
          status: "queued" | "running" | "succeeded" | "failed";
          createdAt: string;
      }>
    | Readonly<{
          accepted: false;
          process?: string;
          version?: string;
          error:
              | Readonly<{
                    code:
                        | "INVALID_INPUT"
                        | "PROCESS_NOT_FOUND"
                        | "IDEMPOTENCY_CONFLICT"
                        | SourceRunErrorCode;
                    message: string;
                    details?: readonly InputValidationDetail[];
                }>
              | Readonly<{
                    code:
                        | "CALLER_BACKLOG_LIMIT_REACHED"
                        | "ASYNC_SERVICE_CAPACITY_REACHED";
                    message: string;
                    retryAfterSeconds: number;
                }>;
      }>;

export type AsyncProcessRuns = Readonly<{
    submit: (
        request: unknown,
        context: Readonly<{ callerId: string; idempotencyKey: string }>,
    ) => Promise<ProcessRunSubmission>;
    find: (
        runId: string,
        context: Readonly<{ callerId: string }>,
    ) => Promise<ProcessRunView | undefined>;
}>;

export function createAsyncProcessRuns(options: {
    registry: ProcessRegistry;
    store: ProcessRunStore;
    queue?: ProcessWorkQueue;
    clock?: () => string;
    createRunId?: () => string;
    sourceRunLookup?: TemplateMasterSourceRunLookup;
}): AsyncProcessRuns {
    const registry = options.registry;
    const store = options.store;
    const queue = options.queue;
    const clock = options.clock ?? (() => new Date().toISOString());
    const createRunId = options.createRunId ?? randomUUID;
    const sourceRunLookup: TemplateMasterSourceRunLookup | undefined =
        options.sourceRunLookup ??
        (store.findById
            ? async (runId) => {
                  const found = await store.findById?.(runId);
                  if (!found) return undefined;
                  return {
                      runId: found.runId,
                      ownerId: found.ownerId,
                      process: found.process,
                      version: found.version,
                      status: found.status,
                      ...("resultExpiredAt" in found &&
                      found.resultExpiredAt !== undefined
                          ? { resultExpiredAt: found.resultExpiredAt }
                          : {}),
                      ...("output" in found && found.output !== undefined
                          ? { output: found.output }
                          : {}),
                  };
              }
            : undefined);

    return Object.freeze({
        submit: async (rawRequest, context) => {
            assertContextValue("callerId", context.callerId);
            assertContextValue("idempotencyKey", context.idempotencyKey);

            const requestResult = processRunRequestSchema.safeParse(rawRequest);
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
                return rejected(
                    "INVALID_INPUT",
                    formatValidationErrorMessage({
                        ...identity,
                        details,
                    }),
                    { ...identity, details },
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
                return rejected(
                    "PROCESS_NOT_FOUND",
                    "The requested process version is not registered",
                    identity,
                );
            }

            const acceptance = registration.accept(request.input);
            if (!acceptance.accepted) {
                const details = acceptance.details;
                return rejected(
                    "INVALID_INPUT",
                    formatValidationErrorMessage({
                        ...identity,
                        details,
                    }),
                    { ...identity, details },
                );
            }

            const requestFingerprint = fingerprint(acceptance.acceptedInput);
            const resolved = await resolveTemplateMasterAcceptedInput(
                acceptance.acceptedInput,
                { callerId: context.callerId },
                sourceRunLookup,
            );
            if (!resolved.ok) {
                return rejected(resolved.code, resolved.message, {
                    ...identity,
                    details: resolved.details,
                });
            }

            let storeResult: ProcessRunAcceptance;
            try {
                storeResult = await store.accept({
                    runId: createRunId(),
                    ownerId: context.callerId,
                    idempotencyKey: context.idempotencyKey,
                    requestFingerprint,
                    process: request.process,
                    version: request.version,
                    acceptedInput: resolved.acceptedInput,
                    createdAt: clock(),
                });
            } catch (error) {
                if (error instanceof ProcessRunBacklogLimitError) {
                    return backlogRejected(error);
                }
                throw error;
            }
            if (storeResult.outcome === "conflict") {
                return rejected(
                    "IDEMPOTENCY_CONFLICT",
                    "The idempotency key was already used for a different request",
                    identity,
                );
            }

            const run = storeResult.run;
            if (storeResult.outcome === "created" && queue) {
                await queue.enqueue({ schemaVersion: 1, runId: run.runId });
            }
            return Object.freeze({
                accepted: true,
                runId: run.runId,
                process: run.process,
                version: run.version,
                status: run.status,
                createdAt: run.createdAt,
            });
        },

        find: async (runId, context) => {
            assertContextValue("callerId", context.callerId);
            const run = await store.findOwned(runId, context.callerId);
            return run ? toProcessRunView(run) : undefined;
        },
    });
}

function rejected(
    code:
        | "INVALID_INPUT"
        | "PROCESS_NOT_FOUND"
        | "IDEMPOTENCY_CONFLICT"
        | SourceRunErrorCode,
    message: string,
    extra: Readonly<{
        process?: string;
        version?: string;
        details?: readonly InputValidationDetail[];
    }> = {},
): ProcessRunSubmission {
    return Object.freeze({
        accepted: false,
        ...(extra.process === undefined ? {} : { process: extra.process }),
        ...(extra.version === undefined ? {} : { version: extra.version }),
        error: Object.freeze({
            code,
            message,
            ...(extra.details && extra.details.length > 0
                ? { details: extra.details }
                : {}),
        }),
    });
}

function backlogRejected(
    error: ProcessRunBacklogLimitError,
): ProcessRunSubmission {
    return Object.freeze({
        accepted: false,
        error: Object.freeze({
            code:
                error.scope === "caller"
                    ? "CALLER_BACKLOG_LIMIT_REACHED"
                    : "ASYNC_SERVICE_CAPACITY_REACHED",
            message:
                error.scope === "caller"
                    ? "Caller Process Run backlog limit reached"
                    : "Async Process Run capacity is temporarily unavailable",
            retryAfterSeconds: error.retryAfterSeconds,
        }),
    });
}

function toProcessRunView(run: StoredProcessRun): ProcessRunView {
    const cost = runCostFromSnapshot(run.costLedger);
    const withCost = cost ? { cost } : {};
    const identity = {
        runId: run.runId,
        process: run.process,
        version: run.version,
        createdAt: run.createdAt,
    };
    switch (run.status) {
        case "queued":
            return { ...identity, status: "queued" };
        case "running":
            return { ...identity, status: "running", startedAt: run.startedAt };
        case "succeeded":
            return run.resultExpiredAt === undefined
                ? {
                      ...identity,
                      status: "succeeded",
                      startedAt: run.startedAt,
                      finishedAt: run.finishedAt,
                      ...withCost,
                      output: structuredClone(run.output),
                  }
                : {
                      ...identity,
                      status: "succeeded",
                      startedAt: run.startedAt,
                      finishedAt: run.finishedAt,
                      ...withCost,
                      resultAvailability: "expired",
                      resultExpiredAt: run.resultExpiredAt,
                  };
        case "failed":
            return run.resultExpiredAt === undefined
                ? {
                      ...identity,
                      status: "failed",
                      startedAt: run.startedAt,
                      finishedAt: run.finishedAt,
                      ...withCost,
                      error: structuredClone(run.error),
                  }
                : {
                      ...identity,
                      status: "failed",
                      startedAt: run.startedAt,
                      finishedAt: run.finishedAt,
                      ...withCost,
                      resultAvailability: "expired",
                      resultExpiredAt: run.resultExpiredAt,
                  };
    }
}

function fingerprint(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    }
    return `{${Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
}

function assertContextValue(
    name: "callerId" | "idempotencyKey",
    value: string,
): void {
    if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        Buffer.byteLength(value, "utf8") > 512
    ) {
        throw new Error(
            `${name} must be a non-empty string of at most 512 bytes`,
        );
    }
}
