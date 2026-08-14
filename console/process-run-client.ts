import type { ProcessErrorCode } from "../src/process-runtime/index.js";
import { createAbortableWait } from "./abortable-wait.js";

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

export type ProcessRunRecoveryClassification =
    | "acceptance-unknown"
    | "retryable"
    | "accepted";

export type PendingProcessRun =
    | Readonly<{
          classification: ProcessRunRecoveryClassification;
          createdAt: string;
          runId?: string;
      }>
    | Readonly<{
          classification: "unavailable";
      }>;

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
              | Readonly<{
                    status: "cancelled";
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
      }>
    | Readonly<{
          status: "submission-pending";
          classification: "acceptance-unknown";
      }>
    | Readonly<{
          status: "submission-pending";
          classification: "retryable";
          httpStatus: 429 | 503;
          retryAfterMs: number;
          error: ProcessRunError;
      }>
    | Readonly<{
          status: "recovery-error";
          code:
              | "ACCEPTED_OPERATION_ACTIVE"
              | "ACTIVE_OPERATION"
              | "REQUEST_MISMATCH"
              | "STORAGE_UNAVAILABLE";
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
            intent?: "continue" | "new";
            signal?: AbortSignal;
        }>,
    ) => Promise<ProcessRunOutcome>;
    pending: () => PendingProcessRun | undefined;
    dismiss: () => boolean;
}>;

type Adapters = Readonly<{
    baseUrl: () => string;
    createIdempotencyKey: () => string;
    fingerprint: (value: string) => Promise<string>;
    now: () => number;
    pendingOperations: Readonly<{
        read: () => string | null;
        write: (value: string) => void;
        clear: () => void;
    }>;
    request: (url: URL, init: RequestInit) => Promise<Response>;
    schedule: (milliseconds: number, operation: () => void) => () => void;
    wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

export const defaultProcessRunTimeoutMs = 300_000;

export function createProcessRunClient(adapters: Adapters): ProcessRunClient {
    let active: Promise<ProcessRunOutcome> | undefined;

    const execute: ProcessRunClient["execute"] = (request, options = {}) => {
        const requestBody = serializeRequest(request);
        if (active) {
            return Promise.resolve(
                Object.freeze({
                    status: "recovery-error",
                    code: "ACTIVE_OPERATION",
                }),
            );
        }
        const operation = executeOperation(request, requestBody, options);
        const tracked = operation.finally(() => {
            if (active === tracked) active = undefined;
        });
        active = tracked;
        return tracked;
    };

    async function executeOperation(
        request: Parameters<ProcessRunClient["execute"]>[0],
        requestBody: string,
        options: NonNullable<Parameters<ProcessRunClient["execute"]>[1]>,
    ): Promise<ProcessRunOutcome> {
        try {
            const timeoutMs = options.timeoutMs ?? defaultProcessRunTimeoutMs;
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
                throw new Error(
                    "Process Run timeout must be a positive integer",
                );
            }

            const baseUrl = new URL(adapters.baseUrl());
            const requestFingerprint = await adapters.fingerprint(requestBody);
            let pending = readPendingOperation(adapters);
            if (
                options.intent === "new" &&
                pending?.classification === "accepted"
            ) {
                return Object.freeze({
                    status: "recovery-error",
                    code: "ACCEPTED_OPERATION_ACTIVE",
                });
            }
            if (options.intent === "new" || !pending) {
                pending = {
                    schemaVersion: 1,
                    requestFingerprint,
                    idempotencyKey: adapters.createIdempotencyKey(),
                    createdAt: new Date(adapters.now()).toISOString(),
                    classification: "acceptance-unknown",
                };
                writePendingOperation(adapters, pending);
            } else if (
                pending.classification !== "accepted" &&
                pending.requestFingerprint !== requestFingerprint
            ) {
                return Object.freeze({
                    status: "recovery-error",
                    code: "REQUEST_MISMATCH",
                });
            }

            if (pending.classification === "accepted") {
                return await poll(
                    {
                        runId: pending.runId,
                        process: pending.process,
                        version: pending.version,
                        status: "queued",
                    },
                    new URL(
                        `/process-runs/${encodeURIComponent(pending.runId)}`,
                        baseUrl,
                    ),
                    timeoutMs,
                    options,
                    0,
                );
            }

            let response: Response;
            try {
                response = await adapters.request(
                    new URL("/process-runs", baseUrl),
                    {
                        method: "POST",
                        headers: {
                            accept: "application/json",
                            "content-type": "application/json",
                            "idempotency-key": pending.idempotencyKey,
                        },
                        body: requestBody,
                        signal: options.signal,
                    },
                );
            } catch {
                writePendingOperation(adapters, {
                    ...pending,
                    classification: "acceptance-unknown",
                });
                return Object.freeze({
                    status: "submission-pending",
                    classification: "acceptance-unknown",
                });
            }

            let body: unknown;
            try {
                body = await readJson(response);
            } catch (error) {
                if (error instanceof ProtocolError) throw error;
                writePendingOperation(adapters, {
                    ...pending,
                    classification: "acceptance-unknown",
                });
                return Object.freeze({
                    status: "submission-pending",
                    classification: "acceptance-unknown",
                });
            }
            if (response.status !== 202) {
                const error = readRejection(
                    body,
                    response.status,
                    submissionErrorStatuses,
                    "INVALID_SUBMISSION",
                );
                if (isRetryableSubmission(response.status, error.code)) {
                    writePendingOperation(adapters, {
                        ...pending,
                        classification: "retryable",
                    });
                    return Object.freeze({
                        status: "submission-pending",
                        classification: "retryable",
                        httpStatus: response.status,
                        retryAfterMs: retryDelayMs(response, adapters.now(), 1),
                        error,
                    });
                }
                clearPendingOperation(adapters);
                return Object.freeze({
                    status: "rejected",
                    phase: "submission",
                    httpStatus: response.status,
                    error,
                });
            }

            const accepted = readAccepted(body, request);
            writePendingOperation(adapters, {
                ...pending,
                classification: "accepted",
                runId: accepted.runId,
                process: accepted.process,
                version: accepted.version,
            });
            const location = readLocation(response, baseUrl, accepted.runId);
            options.onProgress?.({
                phase: "accepted",
                runId: accepted.runId,
                process: accepted.process,
                version: accepted.version,
                status: accepted.status,
            });
            return await poll(
                accepted,
                location,
                timeoutMs,
                options,
                retryDelayMs(response, adapters.now(), 1),
            );
        } catch (error) {
            if (error instanceof ProtocolError) {
                return Object.freeze({
                    status: "protocol-error",
                    code: error.code,
                });
            }
            if (error instanceof RecoveryStorageError) {
                return Object.freeze({
                    status: "recovery-error",
                    code: "STORAGE_UNAVAILABLE",
                });
            }
            throw error;
        }
    }

    async function poll(
        accepted: Accepted,
        location: URL,
        timeoutMs: number,
        options: NonNullable<Parameters<ProcessRunClient["execute"]>[1]>,
        initialDelayMs: number,
    ): Promise<ProcessRunOutcome> {
        const deadline = adapters.now() + timeoutMs;
        let retryAfterMs = initialDelayMs;
        let retryAttempt = 1;
        const polling = new AbortController();
        let stoppedBy: "caller" | "deadline" | undefined;
        const stopForCaller = () => {
            if (stoppedBy) return;
            stoppedBy = "caller";
            polling.abort();
        };
        if (options.signal?.aborted) stopForCaller();
        else
            options.signal?.addEventListener("abort", stopForCaller, {
                once: true,
            });
        const cancelDeadline = adapters.schedule(timeoutMs, () => {
            if (stoppedBy) return;
            stoppedBy = "deadline";
            polling.abort();
        });

        try {
            for (;;) {
                const stopped = stoppedOutcome(accepted, timeoutMs, stoppedBy);
                if (stopped) return stopped;
                const remainingMs = deadline - adapters.now();
                if (remainingMs <= 0) return timedOut(accepted, timeoutMs);
                if (retryAfterMs > 0) {
                    try {
                        await adapters.wait(
                            Math.min(retryAfterMs, remainingMs),
                            polling.signal,
                        );
                    } catch (error) {
                        const stoppedAfterWait = stoppedOutcome(
                            accepted,
                            timeoutMs,
                            stoppedBy,
                        );
                        if (stoppedAfterWait) return stoppedAfterWait;
                        throw error;
                    }
                    if (adapters.now() >= deadline) {
                        return timedOut(accepted, timeoutMs);
                    }
                }

                let observedResponse: Response;
                try {
                    observedResponse = await adapters.request(location, {
                        headers: { accept: "application/json" },
                        signal: polling.signal,
                    });
                } catch {
                    const stoppedAfterRequest = stoppedOutcome(
                        accepted,
                        timeoutMs,
                        stoppedBy,
                    );
                    if (stoppedAfterRequest) return stoppedAfterRequest;
                    retryAttempt += 1;
                    retryAfterMs = backoffMs(retryAttempt);
                    continue;
                }

                const stoppedAfterResponse = stoppedOutcome(
                    accepted,
                    timeoutMs,
                    stoppedBy,
                );
                if (stoppedAfterResponse) return stoppedAfterResponse;

                if (isUnstructuredRetryableQuery(observedResponse)) {
                    retryAttempt += 1;
                    retryAfterMs = retryDelayMs(
                        observedResponse,
                        adapters.now(),
                        retryAttempt,
                    );
                    continue;
                }

                let observedBody: unknown;
                try {
                    observedBody = await readJson(observedResponse);
                } catch (error) {
                    const stoppedAfterBody = stoppedOutcome(
                        accepted,
                        timeoutMs,
                        stoppedBy,
                    );
                    if (stoppedAfterBody) return stoppedAfterBody;
                    if (!isResponseBodyTransportError(error)) throw error;
                    retryAttempt += 1;
                    retryAfterMs = backoffMs(retryAttempt);
                    continue;
                }
                const stoppedAfterBody = stoppedOutcome(
                    accepted,
                    timeoutMs,
                    stoppedBy,
                );
                if (stoppedAfterBody) return stoppedAfterBody;
                if (isStructuredRetryableQuery(observedResponse)) {
                    readRejection(
                        observedBody,
                        observedResponse.status,
                        queryErrorStatuses,
                        "INVALID_RUN",
                    );
                    retryAttempt += 1;
                    retryAfterMs = retryDelayMs(
                        observedResponse,
                        adapters.now(),
                        retryAttempt,
                    );
                    continue;
                }
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
                const terminal = terminalOutcome(observed);
                if (terminal) {
                    clearPendingOperation(adapters);
                    return terminal;
                }
                if (
                    observed.status !== "queued" &&
                    observed.status !== "running"
                ) {
                    throw new ProtocolError("INVALID_RUN");
                }
                options.onProgress?.({
                    phase: "observed",
                    runId: observed.runId,
                    process: observed.process,
                    version: observed.version,
                    status: observed.status,
                });
                retryAttempt = 1;
                retryAfterMs = retryDelayMs(
                    observedResponse,
                    adapters.now(),
                    retryAttempt,
                );
            }
        } finally {
            cancelDeadline();
            options.signal?.removeEventListener("abort", stopForCaller);
        }
    }

    return Object.freeze({
        execute,
        pending: () => {
            try {
                return toPendingProcessRun(readPendingOperation(adapters));
            } catch (error) {
                if (error instanceof RecoveryStorageError) {
                    return Object.freeze({ classification: "unavailable" });
                }
                throw error;
            }
        },
        dismiss: () => {
            if (active) return false;
            try {
                clearPendingOperation(adapters);
                return true;
            } catch (error) {
                if (error instanceof RecoveryStorageError) return false;
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

function cancelled(accepted: Accepted): ProcessRunOutcome {
    return Object.freeze({
        status: "cancelled",
        runId: accepted.runId,
        process: accepted.process,
        version: accepted.version,
    });
}

function stoppedOutcome(
    accepted: Accepted,
    timeoutMs: number,
    stoppedBy: "caller" | "deadline" | undefined,
): ProcessRunOutcome | undefined {
    if (stoppedBy === "caller") return cancelled(accepted);
    if (stoppedBy === "deadline") return timedOut(accepted, timeoutMs);
    return undefined;
}

const scheduleWithTimeout: Adapters["schedule"] = (milliseconds, operation) => {
    const timer = setTimeout(operation, milliseconds);
    return () => clearTimeout(timer);
};

export const processRuns = createProcessRunClient({
    baseUrl: () => document.baseURI,
    createIdempotencyKey: () => crypto.randomUUID(),
    fingerprint: fingerprintWithWebCrypto,
    now: () => Date.now(),
    pendingOperations: {
        read: () => sessionStorage.getItem(pendingOperationStorageKey),
        write: (value) =>
            sessionStorage.setItem(pendingOperationStorageKey, value),
        clear: () => sessionStorage.removeItem(pendingOperationStorageKey),
    },
    request: (url, init) => fetch(url, init),
    schedule: scheduleWithTimeout,
    wait: createAbortableWait(scheduleWithTimeout),
});

const pendingOperationStorageKey = "pipipi.console.process-run.pending.v1";

type PendingOperation =
    | Readonly<{
          schemaVersion: 1;
          requestFingerprint: string;
          idempotencyKey: string;
          createdAt: string;
          classification: "acceptance-unknown" | "retryable";
      }>
    | Readonly<{
          schemaVersion: 1;
          requestFingerprint: string;
          idempotencyKey: string;
          createdAt: string;
          classification: "accepted";
          runId: string;
          process: string;
          version: string;
      }>;

function readPendingOperation(
    adapters: Adapters,
): PendingOperation | undefined {
    let serialized: string | null;
    try {
        serialized = adapters.pendingOperations.read();
    } catch {
        throw new RecoveryStorageError();
    }
    if (serialized === null) return undefined;
    let value: unknown;
    try {
        value = JSON.parse(serialized);
    } catch {
        clearPendingOperation(adapters);
        return undefined;
    }
    if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        !isNonEmptyString(value.requestFingerprint) ||
        !isNonEmptyString(value.idempotencyKey) ||
        !isNonEmptyString(value.createdAt)
    ) {
        clearPendingOperation(adapters);
        return undefined;
    }
    if (
        value.classification === "acceptance-unknown" ||
        value.classification === "retryable"
    ) {
        return {
            schemaVersion: 1,
            requestFingerprint: value.requestFingerprint,
            idempotencyKey: value.idempotencyKey,
            createdAt: value.createdAt,
            classification: value.classification,
        };
    }
    if (
        value.classification === "accepted" &&
        isNonEmptyString(value.runId) &&
        isNonEmptyString(value.process) &&
        isNonEmptyString(value.version)
    ) {
        return {
            schemaVersion: 1,
            requestFingerprint: value.requestFingerprint,
            idempotencyKey: value.idempotencyKey,
            createdAt: value.createdAt,
            classification: "accepted",
            runId: value.runId,
            process: value.process,
            version: value.version,
        };
    }
    clearPendingOperation(adapters);
    return undefined;
}

function writePendingOperation(
    adapters: Adapters,
    operation: PendingOperation,
): void {
    try {
        adapters.pendingOperations.write(JSON.stringify(operation));
    } catch {
        throw new RecoveryStorageError();
    }
}

function clearPendingOperation(adapters: Adapters): void {
    try {
        adapters.pendingOperations.clear();
    } catch {
        throw new RecoveryStorageError();
    }
}

function toPendingProcessRun(
    operation: PendingOperation | undefined,
): PendingProcessRun | undefined {
    if (!operation) return undefined;
    return Object.freeze({
        classification: operation.classification,
        createdAt: operation.createdAt,
        ...(operation.classification === "accepted"
            ? { runId: operation.runId }
            : {}),
    });
}

function isRetryableSubmission(
    httpStatus: number,
    code: ProcessRunError["code"],
): httpStatus is 429 | 503 {
    return (
        (httpStatus === 429 && code === "CALLER_BACKLOG_LIMIT_REACHED") ||
        (httpStatus === 503 &&
            (code === "ASYNC_SERVICE_CAPACITY_REACHED" ||
                code === "ASYNC_SERVICE_UNAVAILABLE" ||
                code === "SERVICE_BUSY"))
    );
}

function terminalOutcome(observed: Observed): ProcessRunOutcome | undefined {
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
    return undefined;
}

function serializeRequest(request: unknown): string {
    return JSON.stringify(canonicalJson(request));
}

function canonicalJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonicalJson(item)]),
    );
}

async function fingerprintWithWebCrypto(value: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
}

class RecoveryStorageError extends Error {
    constructor() {
        super("Process Run recovery storage is unavailable");
        this.name = "RecoveryStorageError";
    }
}

class ProtocolError extends Error {
    constructor(readonly code: ProcessRunProtocolErrorCode) {
        super(code);
        this.name = "ProtocolError";
    }
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new ProtocolError("INVALID_JSON");
        }
        throw error;
    }
}

function isResponseBodyTransportError(error: unknown): boolean {
    return (
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "AbortError")
    );
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

const minimumRetryDelayMs = 1_000;
const maximumRetryDelayMs = 30_000;

function retryDelayMs(
    response: Response,
    now: number,
    attempt: number,
): number {
    const header = response.headers.get("retry-after")?.trim();
    if (header) {
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds > 0) {
            return boundRetryDelay(seconds * 1_000);
        }
        const date = Date.parse(header);
        if (Number.isFinite(date) && date > now) {
            return boundRetryDelay(date - now);
        }
    }
    return backoffMs(attempt);
}

function backoffMs(attempt: number): number {
    return Math.min(
        minimumRetryDelayMs * 2 ** Math.max(0, attempt - 1),
        maximumRetryDelayMs,
    );
}

function boundRetryDelay(milliseconds: number): number {
    return Math.min(
        maximumRetryDelayMs,
        Math.max(minimumRetryDelayMs, milliseconds),
    );
}

function isUnstructuredRetryableQuery(response: Response): boolean {
    if (
        response.status === 429 ||
        response.status === 502 ||
        response.status === 504
    ) {
        return true;
    }
    return (
        (response.status === 500 || response.status === 503) &&
        !response.headers.get("content-type")?.includes("application/json")
    );
}

function isStructuredRetryableQuery(response: Response): boolean {
    return response.status === 500 || response.status === 503;
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
