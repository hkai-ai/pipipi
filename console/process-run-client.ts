import type { ProcessErrorCode } from "../src/process-runtime/index.js";

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | Readonly<{ [key: string]: JsonValue }>;

type RunIdentity = Readonly<{
    runId: string;
    process: string;
    version: string;
}>;

export type ProcessRunProgress =
    | (RunIdentity &
          Readonly<{
              phase: "accepted";
              status: "queued" | "running" | "succeeded" | "failed";
          }>)
    | (RunIdentity &
          Readonly<{
              phase: "observed";
              status: "queued" | "running";
          }>);

export type ProcessRunRequestErrorCode =
    | "ASYNC_SERVICE_CAPACITY_REACHED"
    | "ASYNC_SERVICE_UNAVAILABLE"
    | "CALLER_BACKLOG_LIMIT_REACHED"
    | "CALLER_UNAUTHORIZED"
    | "IDEMPOTENCY_CONFLICT"
    | "IDEMPOTENCY_KEY_REQUIRED"
    | "INTERNAL_ERROR"
    | "INVALID_IDEMPOTENCY_KEY"
    | "INVALID_INPUT"
    | "PROCESS_NOT_FOUND"
    | "PROCESS_RUN_NOT_FOUND"
    | "REQUEST_TOO_LARGE"
    | "SERVICE_BUSY"
    | "UNSUPPORTED_MEDIA_TYPE";

export type ProcessRunError = Readonly<{
    code: ProcessErrorCode | ProcessRunRequestErrorCode;
    message: string;
}>;

export type ProcessRunProtocolErrorCode =
    | "INVALID_JSON"
    | "INVALID_SUBMISSION"
    | "MISSING_LOCATION"
    | "UNSAFE_LOCATION"
    | "INVALID_RUN"
    | "RUN_MISMATCH";

export type ProcessRunOutcome =
    | (RunIdentity &
          (
              | Readonly<{
                    status: "succeeded";
                    output: JsonValue;
                }>
              | Readonly<{
                    status: "failed";
                    error: ProcessRunError;
                }>
              | Readonly<{
                    status: "result-expired";
                    resultStatus: "succeeded" | "failed";
                    resultExpiredAt: string;
                }>
              | Readonly<{
                    status: "timed-out";
                    timeoutMs: number;
                }>
          ))
    | Readonly<{
          status: "rejected";
          phase: "submission";
          httpStatus: number;
          error: ProcessRunError;
      }>
    | (RunIdentity &
          Readonly<{
              status: "rejected";
              phase: "query";
              httpStatus: number;
              error: ProcessRunError;
          }>)
    | Readonly<{
          status: "protocol-error";
          code: ProcessRunProtocolErrorCode;
      }>;

export type ProcessRunClient = Readonly<{
    execute: (
        request: Readonly<{
            process: string;
            version: string;
            input: Record<string, unknown>;
        }>,
        options?: Readonly<{
            timeoutMs?: number;
            onProgress?: (progress: ProcessRunProgress) => void;
        }>,
    ) => Promise<ProcessRunOutcome>;
}>;

type Adapters = Readonly<{
    baseUrl: () => string;
    createIdempotencyKey: () => string;
    now: () => number;
    request: (url: URL, init: RequestInit) => Promise<Response>;
    wait: (milliseconds: number) => Promise<void>;
}>;

export const defaultProcessRunTimeoutMs = 300_000;

export function createProcessRunClient(adapters: Adapters): ProcessRunClient {
    return Object.freeze({
        execute: async (request, options = {}) => {
            try {
                const timeoutMs =
                    options.timeoutMs ?? defaultProcessRunTimeoutMs;
                if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
                    throw new Error(
                        "Process Run timeout must be a positive integer",
                    );
                }

                const baseUrl = new URL(adapters.baseUrl());
                const response = await adapters.request(
                    new URL("/process-runs", baseUrl),
                    {
                        method: "POST",
                        headers: {
                            accept: "application/json",
                            "content-type": "application/json",
                            "idempotency-key": adapters.createIdempotencyKey(),
                        },
                        body: JSON.stringify(request),
                    },
                );
                const body = await readJson(response);
                if (response.status !== 202) {
                    return Object.freeze({
                        status: "rejected",
                        phase: "submission",
                        httpStatus: response.status,
                        error: readRejection(
                            body,
                            response.status,
                            submissionErrorStatuses,
                            "INVALID_SUBMISSION",
                        ),
                    });
                }
                const accepted = readAccepted(body, request);
                const location = readLocation(
                    response,
                    baseUrl,
                    accepted.runId,
                );
                options.onProgress?.({
                    phase: "accepted",
                    runId: accepted.runId,
                    process: accepted.process,
                    version: accepted.version,
                    status: accepted.status,
                });

                const deadline = adapters.now() + timeoutMs;
                let retryAfterMs = readRetryAfterMs(response);
                for (;;) {
                    const remainingMs = deadline - adapters.now();
                    if (remainingMs <= 0) {
                        return timedOut(accepted, timeoutMs);
                    }
                    await adapters.wait(Math.min(retryAfterMs, remainingMs));
                    if (adapters.now() >= deadline) {
                        return timedOut(accepted, timeoutMs);
                    }

                    const observedResponse = await adapters.request(location, {
                        headers: { accept: "application/json" },
                    });
                    const observedBody = await readJson(observedResponse);
                    if (observedResponse.status !== 200) {
                        return Object.freeze({
                            status: "rejected",
                            phase: "query",
                            httpStatus: observedResponse.status,
                            runId: accepted.runId,
                            process: accepted.process,
                            version: accepted.version,
                            error: readRejection(
                                observedBody,
                                observedResponse.status,
                                queryErrorStatuses,
                                "INVALID_RUN",
                            ),
                        });
                    }
                    const observed = readObserved(observedBody, accepted);
                    if (observed.status === "succeeded") {
                        return Object.freeze({
                            status: "succeeded",
                            runId: observed.runId,
                            process: observed.process,
                            version: observed.version,
                            output: observed.output,
                        });
                    }
                    if (observed.status === "failed") {
                        return Object.freeze({
                            status: "failed",
                            runId: observed.runId,
                            process: observed.process,
                            version: observed.version,
                            error: observed.error,
                        });
                    }
                    if (observed.status === "result-expired") {
                        return Object.freeze({
                            status: "result-expired",
                            resultStatus: observed.resultStatus,
                            runId: observed.runId,
                            process: observed.process,
                            version: observed.version,
                            resultExpiredAt: observed.resultExpiredAt,
                        });
                    }
                    options.onProgress?.({
                        phase: "observed",
                        runId: observed.runId,
                        process: observed.process,
                        version: observed.version,
                        status: observed.status,
                    });
                    retryAfterMs = readRetryAfterMs(observedResponse);
                }
            } catch (error) {
                if (error instanceof ProtocolError) {
                    return Object.freeze({
                        status: "protocol-error",
                        code: error.code,
                    });
                }
                throw error;
            }
        },
    });
}

function timedOut(accepted: Accepted, timeoutMs: number): ProcessRunOutcome {
    return Object.freeze({
        status: "timed-out",
        runId: accepted.runId,
        process: accepted.process,
        version: accepted.version,
        timeoutMs,
    });
}

export const processRuns = createProcessRunClient({
    baseUrl: () => document.baseURI,
    createIdempotencyKey: () => crypto.randomUUID(),
    now: () => Date.now(),
    request: (url, init) => fetch(url, init),
    wait: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
});

class ProtocolError extends Error {
    constructor(readonly code: ProcessRunProtocolErrorCode) {
        super(code);
        this.name = "ProtocolError";
    }
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        throw new ProtocolError("INVALID_JSON");
    }
}

type Accepted = RunIdentity &
    Readonly<{
        status: "queued" | "running" | "succeeded" | "failed";
    }>;

type Observed =
    | (RunIdentity & Readonly<{ status: "queued" | "running" }>)
    | (RunIdentity & Readonly<{ status: "succeeded"; output: JsonValue }>)
    | (RunIdentity & Readonly<{ status: "failed"; error: ProcessRunError }>)
    | (RunIdentity &
          Readonly<{
              status: "result-expired";
              resultStatus: "succeeded" | "failed";
              resultExpiredAt: string;
          }>);

function readAccepted(
    value: unknown,
    request: Readonly<{ process: string; version: string }>,
): Accepted {
    if (
        !isRecord(value) ||
        !isNonEmptyString(value.runId) ||
        value.process !== request.process ||
        value.version !== request.version ||
        !isStatus(value.status) ||
        !isNonEmptyString(value.createdAt)
    ) {
        throw new ProtocolError("INVALID_SUBMISSION");
    }
    return {
        runId: value.runId,
        process: value.process,
        version: value.version,
        status: value.status,
    };
}

function readRejection(
    value: unknown,
    httpStatus: number,
    statuses: ReadonlyMap<string, number>,
    protocolCode: "INVALID_SUBMISSION" | "INVALID_RUN",
): ProcessRunError {
    const error =
        isRecord(value) && value.status === "failed"
            ? readError(value.error, statuses)
            : undefined;
    if (!error || statuses.get(error.code) !== httpStatus) {
        throw new ProtocolError(protocolCode);
    }
    return error;
}

const terminalErrorCodes = new Set<string>([
    "AGENT_FAILURE",
    "DEPENDENCY_FAILURE",
    "DEPENDENCY_FAILURE_AFTER_COMMIT",
    "INTERNAL_ERROR",
    "INVALID_INPUT",
    "INVALID_OUTPUT",
    "PROCESS_NOT_FOUND",
    "PROCESS_TIMEOUT",
]);

const submissionErrorStatuses = new Map<string, number>([
    ["ASYNC_SERVICE_CAPACITY_REACHED", 503],
    ["ASYNC_SERVICE_UNAVAILABLE", 503],
    ["CALLER_BACKLOG_LIMIT_REACHED", 429],
    ["CALLER_UNAUTHORIZED", 401],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["IDEMPOTENCY_KEY_REQUIRED", 400],
    ["INTERNAL_ERROR", 500],
    ["INVALID_IDEMPOTENCY_KEY", 400],
    ["INVALID_INPUT", 400],
    ["PROCESS_NOT_FOUND", 404],
    ["REQUEST_TOO_LARGE", 413],
    ["SERVICE_BUSY", 503],
    ["UNSUPPORTED_MEDIA_TYPE", 415],
]);

const queryErrorStatuses = new Map<string, number>([
    ["ASYNC_SERVICE_UNAVAILABLE", 503],
    ["CALLER_UNAUTHORIZED", 401],
    ["INTERNAL_ERROR", 500],
    ["PROCESS_RUN_NOT_FOUND", 404],
    ["SERVICE_BUSY", 503],
]);

function readError(
    value: unknown,
    codes: Readonly<{ has: (code: string) => boolean }>,
): ProcessRunError | undefined {
    if (
        !isRecord(value) ||
        !isNonEmptyString(value.code) ||
        !codes.has(value.code) ||
        !isNonEmptyString(value.message)
    ) {
        return undefined;
    }
    return {
        code: value.code as ProcessErrorCode | ProcessRunRequestErrorCode,
        message: value.message,
    };
}

function readObserved(value: unknown, accepted: Accepted): Observed {
    if (
        !isRecord(value) ||
        !isNonEmptyString(value.runId) ||
        !isNonEmptyString(value.process) ||
        !isNonEmptyString(value.version) ||
        !isNonEmptyString(value.createdAt)
    ) {
        throw new ProtocolError("INVALID_RUN");
    }
    if (
        value.runId !== accepted.runId ||
        value.process !== accepted.process ||
        value.version !== accepted.version
    ) {
        throw new ProtocolError("RUN_MISMATCH");
    }
    if (value.status === "queued") {
        return { ...accepted, status: "queued" };
    }
    if (value.status === "running") {
        if (!isNonEmptyString(value.startedAt)) {
            throw new ProtocolError("INVALID_RUN");
        }
        return { ...accepted, status: "running" };
    }
    if (
        (value.status === "succeeded" || value.status === "failed") &&
        value.resultAvailability === "expired" &&
        isNonEmptyString(value.startedAt) &&
        isNonEmptyString(value.finishedAt) &&
        isNonEmptyString(value.resultExpiredAt)
    ) {
        return {
            ...accepted,
            status: "result-expired",
            resultStatus: value.status,
            resultExpiredAt: value.resultExpiredAt,
        };
    }
    if (
        value.status === "succeeded" &&
        isNonEmptyString(value.startedAt) &&
        isNonEmptyString(value.finishedAt) &&
        isJsonValue(value.output)
    ) {
        return { ...accepted, status: "succeeded", output: value.output };
    }
    if (
        value.status === "failed" &&
        isNonEmptyString(value.startedAt) &&
        isNonEmptyString(value.finishedAt)
    ) {
        const error = readError(value.error, terminalErrorCodes);
        if (!error) throw new ProtocolError("INVALID_RUN");
        return {
            ...accepted,
            status: "failed",
            error,
        };
    }
    throw new ProtocolError("INVALID_RUN");
}

function readLocation(response: Response, baseUrl: URL, runId: string): URL {
    const header = response.headers.get("location");
    if (!header) throw new ProtocolError("MISSING_LOCATION");
    let location: URL;
    try {
        location = new URL(header, baseUrl);
    } catch {
        throw new ProtocolError("UNSAFE_LOCATION");
    }
    const match = /^\/process-runs\/([^/]+)$/.exec(location.pathname);
    let locationRunId: string | undefined;
    try {
        locationRunId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
    } catch {
        throw new ProtocolError("UNSAFE_LOCATION");
    }
    if (
        location.origin !== baseUrl.origin ||
        location.search !== "" ||
        location.hash !== "" ||
        locationRunId !== runId
    ) {
        throw new ProtocolError("UNSAFE_LOCATION");
    }
    return location;
}

function readRetryAfterMs(response: Response): number {
    const seconds = Number(response.headers.get("retry-after") ?? "2");
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 2_000;
}

function isStatus(
    value: unknown,
): value is "queued" | "running" | "succeeded" | "failed" {
    return (
        value === "queued" ||
        value === "running" ||
        value === "succeeded" ||
        value === "failed"
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isJsonValue(value: unknown): value is JsonValue {
    if (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "string"
    ) {
        return true;
    }
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    return (
        isRecord(value) &&
        Object.values(value).every((item) => isJsonValue(item))
    );
}
