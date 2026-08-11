import type {
    IncomingMessage,
    RequestListener,
    ServerResponse,
} from "node:http";
import type {
    AsyncProcessRuns,
    ProcessRunSubmission,
    ProcessRunView,
} from "../process-runs/index.js";
import type {
    ProcessErrorCode,
    ProcessExecutor,
    ProcessRunLogRecord,
    ProcessRunResult,
} from "../process-runtime/index.js";
import type { ProcessRunRecord } from "../process-runtime/records.js";
import { renderConsolePage } from "./console-page.js";
import type { CallerIdentityResolver } from "./identity.js";

export const defaultHttpMaxRequestBodyBytes = 262_144;
export const defaultMaxConcurrentExecutions = 4;

/**
 * Header carrying the caller's own trace identifier. It is recorded on every
 * log record for this request, including transport rejections that never reach
 * the executor and therefore have no `runId`. It never changes execution and is
 * never echoed back to the caller.
 */
export const callerRequestIdHeader = "x-request-id";

const maxCallerRequestIdLength = 200;
const safeCallerRequestId = /^[A-Za-z0-9_.:-]+$/;

export type ProcessingHttpOptions = {
    maxRequestBodyBytes?: number;
    maxConcurrentExecutions?: number;
    logSink?: ProcessingLogSink;
    clock?: ProcessingClock;
    asyncProcessRuns?: AsyncProcessRunsHttpOptions;
    console?: ConsoleHttpOptions;
};

export type ConsoleRecordPage = Readonly<{
    records: readonly ProcessRunRecord[];
    nextBefore?: string;
}>;

/**
 * Serves the operator console and the Run Records behind it. This is an
 * operations Interface, not part of the product contract: it is mounted only
 * when a durable Run Record archive is configured.
 */
export type ConsoleHttpOptions = Readonly<{
    basePath: string;
    records: Readonly<{
        list: (
            query: Readonly<{ limit?: number; before?: string }>,
        ) => Promise<ConsoleRecordPage>;
        find: (runId: string) => Promise<ProcessRunRecord | undefined>;
    }>;
    activities?: Readonly<{
        findByRun: (runId: string) => Promise<readonly ProcessRunLogRecord[]>;
    }>;
    /** The fixed production catalog. Absent when catalog exposure is off. */
    processes?: readonly ConsoleProcessDescription[];
    stats?: Readonly<{
        summarise: (
            query: Readonly<{ since: string }>,
        ) => Promise<ConsoleStatsSummary>;
    }>;
}>;

/**
 * What the service has been doing, derived from the observation archive. Live
 * concurrency is added by the HTTP layer, because occupancy exists only in the
 * process serving the request.
 */
export type ConsoleStatsSummary = Readonly<{
    since: string;
    totals: Readonly<{ succeeded: number; failed: number }>;
    byProcess: readonly Readonly<{
        process: string;
        version: string;
        succeeded: number;
        failed: number;
    }>[];
    byErrorCode: readonly Readonly<{ errorCode: string; count: number }>[];
    attemptDurationMs: Readonly<{
        samples: number;
        p50?: number;
        p95?: number;
        max?: number;
    }>;
}>;

export type ConsoleStats = ConsoleStatsSummary &
    Readonly<{
        concurrency: Readonly<{ active: number; limit: number }>;
    }>;

/**
 * How one registered Process version is described to operators. The Schemas are
 * derived from the Registration's own validation, so this cannot drift from
 * what the service actually accepts and returns. A Schema is omitted when it
 * has no JSON Schema representation.
 */
export type ConsoleProcessDescription = Readonly<{
    process: string;
    version: string;
    activities: readonly string[];
    retry: Readonly<{
        maximumAttempts: number;
        retryableErrorCodes: readonly string[];
    }>;
    input?: unknown;
    output?: unknown;
}>;

export type AsyncProcessRunsHttpOptions = Readonly<{
    runs: AsyncProcessRuns;
    callerIdentity: CallerIdentityResolver;
    readiness: () => Promise<void>;
    retryAfterSeconds?: number;
}>;

export type ProcessingClock = {
    timestamp: () => string;
    monotonicMilliseconds: () => number;
};

export type ProcessRunCompletedLogRecord = {
    event: "process_run_completed";
    timestamp: string;
    runId: string;
    process: string;
    version: string;
    status: "succeeded" | "failed";
    durationMs: number;
    errorCode?: ProcessErrorCode;
    requestId?: string;
};

export type HttpTransportErrorCode =
    | "INTERNAL_ERROR"
    | "REQUEST_TOO_LARGE"
    | "SERVICE_BUSY"
    | "UNSUPPORTED_MEDIA_TYPE";

export type HttpRequestRejectedLogRecord = {
    event: "http_request_rejected" | "http_request_failed";
    timestamp: string;
    httpStatus: number;
    errorCode: HttpTransportErrorCode;
    durationMs: number;
    requestId?: string;
};

export type AsyncProcessRunLogRecord =
    | Readonly<{
          event: "process_run_submission_accepted";
          timestamp: string;
          runId: string;
          process: string;
          version: string;
          durationMs: number;
          requestId?: string;
      }>
    | Readonly<{
          event: "process_run_observed";
          timestamp: string;
          runId: string;
          status: "queued" | "running" | "succeeded" | "failed";
          durationMs: number;
          requestId?: string;
      }>
    | Readonly<{
          event: "process_run_admission_rejected";
          timestamp: string;
          scope: "caller" | "global";
          httpStatus: 429 | 503;
          retryAfterSeconds: number;
          durationMs: number;
          requestId?: string;
      }>;

export type ProcessingLogRecord =
    | ProcessRunCompletedLogRecord
    | HttpRequestRejectedLogRecord
    | AsyncProcessRunLogRecord;

export type ProcessingLogSink = (record: ProcessingLogRecord) => void;

type RequestLoggingContext = {
    logSink: ProcessingLogSink;
    clock: ProcessingClock;
    startedAt: number;
    requestId?: string;
};

type RequestHandlingContext = {
    executor: ProcessExecutor;
    maxRequestBodyBytes: number;
    admission: ExecutionAdmissionController;
    logging: RequestLoggingContext;
    asyncProcessRuns?: AsyncProcessRunsHttpOptions;
    console?: ConsoleHttpOptions;
};

type TransportFailure = {
    status: number;
    errorCode: HttpTransportErrorCode;
    message: string;
};

const unsupportedMediaTypeFailure: TransportFailure = {
    status: 415,
    errorCode: "UNSUPPORTED_MEDIA_TYPE",
    message: "Content-Type must be application/json",
};

const requestTooLargeFailure: TransportFailure = {
    status: 413,
    errorCode: "REQUEST_TOO_LARGE",
    message: "Request body exceeds the configured limit",
};

const serviceBusyFailure: TransportFailure = {
    status: 503,
    errorCode: "SERVICE_BUSY",
    message: "Service is at capacity",
};

export function createProcessingRequestListener(
    executor: ProcessExecutor,
    options: ProcessingHttpOptions = {},
): RequestListener {
    const maxRequestBodyBytes =
        options.maxRequestBodyBytes ?? defaultHttpMaxRequestBodyBytes;
    const maxConcurrentExecutions =
        options.maxConcurrentExecutions ?? defaultMaxConcurrentExecutions;
    const logSink = options.logSink ?? writeStdoutLog;
    const clock = options.clock ?? systemClock;
    const admission = createExecutionAdmissionController(
        maxConcurrentExecutions,
    );
    return (request, response) => {
        const requestId = parseCallerRequestId(
            request.headers[callerRequestIdHeader],
        );
        const context: RequestHandlingContext = {
            executor,
            maxRequestBodyBytes,
            admission,
            logging: {
                logSink,
                clock,
                startedAt: clock.monotonicMilliseconds(),
                ...(requestId === undefined ? {} : { requestId }),
            },
            asyncProcessRuns: options.asyncProcessRuns,
            console: options.console,
        };
        void handleRequest(request, response, context).catch(() => {
            emitLog(context.logging, {
                event: "http_request_failed",
                timestamp: context.logging.clock.timestamp(),
                httpStatus: 500,
                errorCode: "INTERNAL_ERROR",
                durationMs: elapsedMilliseconds(
                    context.logging.clock,
                    context.logging.startedAt,
                ),
            });
            if (response.headersSent || response.writableEnded) {
                if (!response.writableEnded) response.end();
                return;
            }

            try {
                writeFailureJson(
                    response,
                    500,
                    "INTERNAL_ERROR",
                    "The request could not be completed",
                );
            } catch {
                response.destroy();
            }
        });
    };
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    context: RequestHandlingContext,
): Promise<void> {
    if (request.method === "GET" && request.url === "/healthz") {
        writeJson(response, 200, { status: "ok" });
        return;
    }

    if (request.method === "GET" && request.url === "/readyz") {
        await handleReadiness(response, context.asyncProcessRuns);
        return;
    }

    if (context.console && request.method === "GET") {
        const handled = await handleConsole(
            request,
            response,
            context.console,
            context.admission,
        );
        if (handled) return;
    }

    if (
        context.asyncProcessRuns &&
        request.method === "POST" &&
        request.url === "/process-runs"
    ) {
        await submitProcessRun(request, response, context);
        return;
    }

    const asyncRunId =
        context.asyncProcessRuns && request.method === "GET"
            ? processRunIdFromPath(request.url)
            : undefined;
    if (context.asyncProcessRuns && asyncRunId !== undefined) {
        await findProcessRun(
            request,
            response,
            asyncRunId,
            context.asyncProcessRuns,
            context.logging,
        );
        return;
    }

    if (request.method !== "POST" || request.url !== "/execute") {
        writeFailureJson(response, 404, "ROUTE_NOT_FOUND", "Route not found");
        return;
    }

    if (!isJsonMediaType(request.headers["content-type"])) {
        rejectRequest(response, unsupportedMediaTypeFailure, context.logging);
        return;
    }

    const requestBody = await readRequestBody(
        request,
        context.maxRequestBodyBytes,
    );
    if (requestBody.kind === "too_large") {
        rejectRequest(response, requestTooLargeFailure, context.logging);
        return;
    }

    const releaseExecution = context.admission.tryAcquire();
    if (!releaseExecution) {
        response.setHeader("retry-after", "1");
        rejectRequest(response, serviceBusyFailure, context.logging);
        return;
    }

    try {
        const result = await context.executor.execute(requestBody.value);
        emitLog(context.logging, {
            event: "process_run_completed",
            timestamp: context.logging.clock.timestamp(),
            runId: result.runId,
            process: result.process ?? "unknown",
            version: result.version ?? "unknown",
            status: result.status,
            durationMs: elapsedMilliseconds(
                context.logging.clock,
                context.logging.startedAt,
            ),
            ...(result.status === "failed"
                ? { errorCode: result.error.code }
                : {}),
        });
        writeJson(response, statusFor(result), result);
    } finally {
        releaseExecution();
    }
}

/**
 * Handles the console document and its Run Record reads. Returns `false` when
 * the request is not addressed to the console, so unrelated paths keep falling
 * through to the business routes.
 */
async function handleConsole(
    request: IncomingMessage,
    response: ServerResponse,
    options: ConsoleHttpOptions,
    admission: ExecutionAdmissionController,
): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://console.invalid");
    const path = url.pathname;
    const base = options.basePath;
    if (path !== base && !path.startsWith(`${base}/`)) return false;

    if (path === base || path === `${base}/`) {
        response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-robots-tag": "noindex, nofollow",
        });
        response.end(renderConsolePage(base));
        return true;
    }

    if (options.stats && path === `${base}/stats`) {
        const hours = parseStatsHours(url.searchParams.get("hours"));
        if (hours === "invalid") {
            writeFailureJson(
                response,
                400,
                "INVALID_INPUT",
                "hours must be an integer between 1 and 720",
            );
            return true;
        }
        const since = new Date(Date.now() - hours * 3_600_000).toISOString();
        response.setHeader("cache-control", "no-store");
        writeJson(response, 200, {
            ...(await options.stats.summarise({ since })),
            concurrency: admission.occupancy(),
        });
        return true;
    }

    if (options.processes && path === `${base}/processes`) {
        response.setHeader("cache-control", "no-store");
        writeJson(response, 200, { processes: options.processes });
        return true;
    }

    if (path === `${base}/runs`) {
        const limit = parseListLimitParameter(url.searchParams.get("limit"));
        if (limit === "invalid") {
            writeFailureJson(
                response,
                400,
                "INVALID_INPUT",
                "limit must be a positive integer",
            );
            return true;
        }
        const before = url.searchParams.get("before") ?? undefined;
        response.setHeader("cache-control", "no-store");
        writeJson(
            response,
            200,
            await options.records.list({
                ...(limit === undefined ? {} : { limit }),
                ...(before === undefined ? {} : { before }),
            }),
        );
        return true;
    }

    const activityRunId = options.activities
        ? consoleRunIdFromPath(path, base, "/activities")
        : undefined;
    if (options.activities && activityRunId !== undefined) {
        response.setHeader("cache-control", "no-store");
        writeJson(response, 200, {
            runId: activityRunId,
            activities: await options.activities.findByRun(activityRunId),
        });
        return true;
    }

    const runId = consoleRunIdFromPath(path, base);
    if (runId !== undefined) {
        const record = await options.records.find(runId);
        response.setHeader("cache-control", "no-store");
        if (!record) {
            writeFailureJson(
                response,
                404,
                "PROCESS_RUN_RECORD_NOT_FOUND",
                "Process Run Record not found",
            );
            return true;
        }
        writeJson(response, 200, record);
        return true;
    }

    writeFailureJson(response, 404, "ROUTE_NOT_FOUND", "Route not found");
    return true;
}

function parseStatsHours(value: string | null): number | "invalid" {
    if (value === null) return 24;
    if (!/^\d+$/.test(value)) return "invalid";
    const hours = Number(value);
    return hours >= 1 && hours <= 720 ? hours : "invalid";
}

function parseListLimitParameter(
    value: string | null,
): number | undefined | "invalid" {
    if (value === null) return undefined;
    if (!/^\d+$/.test(value)) return "invalid";
    const limit = Number(value);
    return limit >= 1 ? limit : "invalid";
}

/**
 * Extracts the run id from `{base}/runs/{runId}{suffix}`. The id may not
 * contain a slash, so a deeper path never resolves to a run.
 */
function consoleRunIdFromPath(
    path: string,
    basePath: string,
    suffix = "",
): string | undefined {
    const prefix = `${basePath}/runs/`;
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return undefined;
    const candidate = path.slice(
        prefix.length,
        suffix.length === 0 ? undefined : -suffix.length,
    );
    if (candidate.length === 0 || candidate.includes("/")) return undefined;
    try {
        return decodeURIComponent(candidate);
    } catch {
        return undefined;
    }
}

async function handleReadiness(
    response: ServerResponse,
    asyncOptions: AsyncProcessRunsHttpOptions | undefined,
): Promise<void> {
    response.setHeader("cache-control", "no-store");
    if (!asyncOptions) {
        writeJson(response, 200, { status: "ready" });
        return;
    }
    try {
        await asyncOptions.readiness();
        writeJson(response, 200, { status: "ready" });
    } catch {
        writeJson(response, 503, { status: "not_ready" });
    }
}

async function submitProcessRun(
    request: IncomingMessage,
    response: ServerResponse,
    context: RequestHandlingContext,
): Promise<void> {
    const asyncOptions = context.asyncProcessRuns;
    if (!asyncOptions) throw new Error("Async Process Runs are not configured");
    const caller = await resolveCaller(request, response, asyncOptions);
    if (!caller) return;

    const idempotencyKeyHeader = request.headers["idempotency-key"];
    if (
        idempotencyKeyHeader === undefined ||
        (typeof idempotencyKeyHeader === "string" &&
            idempotencyKeyHeader.trim().length === 0)
    ) {
        writeFailureJson(
            response,
            400,
            "IDEMPOTENCY_KEY_REQUIRED",
            "Idempotency-Key is required",
        );
        return;
    }
    if (
        typeof idempotencyKeyHeader !== "string" ||
        Buffer.byteLength(idempotencyKeyHeader, "utf8") > 512
    ) {
        writeFailureJson(
            response,
            400,
            "INVALID_IDEMPOTENCY_KEY",
            "Idempotency-Key must be at most 512 bytes",
        );
        return;
    }
    if (!isJsonMediaType(request.headers["content-type"])) {
        rejectRequest(response, unsupportedMediaTypeFailure, context.logging);
        return;
    }
    const requestBody = await readRequestBody(
        request,
        context.maxRequestBodyBytes,
    );
    if (requestBody.kind === "too_large") {
        rejectRequest(response, requestTooLargeFailure, context.logging);
        return;
    }

    let submission: ProcessRunSubmission;
    try {
        submission = await asyncOptions.runs.submit(requestBody.value, {
            callerId: caller.callerId,
            idempotencyKey: idempotencyKeyHeader,
        });
    } catch {
        writeAsyncUnavailable(response, asyncOptions);
        return;
    }
    if (!submission.accepted) {
        if (
            submission.error.code === "CALLER_BACKLOG_LIMIT_REACHED" ||
            submission.error.code === "ASYNC_SERVICE_CAPACITY_REACHED"
        ) {
            writeBacklogLimit(response, submission.error, context.logging);
            return;
        }
        const status = {
            INVALID_INPUT: 400,
            PROCESS_NOT_FOUND: 404,
            IDEMPOTENCY_CONFLICT: 409,
        }[submission.error.code];
        writeFailureJson(
            response,
            status,
            submission.error.code,
            submission.error.message,
        );
        return;
    }

    const retryAfter = retryAfterSeconds(asyncOptions);
    emitLog(context.logging, {
        event: "process_run_submission_accepted",
        timestamp: context.logging.clock.timestamp(),
        runId: submission.runId,
        process: submission.process,
        version: submission.version,
        durationMs: elapsedMilliseconds(
            context.logging.clock,
            context.logging.startedAt,
        ),
    });
    response.setHeader("location", `/process-runs/${submission.runId}`);
    response.setHeader("retry-after", String(retryAfter));
    response.setHeader("cache-control", "no-store");
    writeJson(response, 202, {
        runId: submission.runId,
        process: submission.process,
        version: submission.version,
        status: submission.status,
        createdAt: submission.createdAt,
    });
}

async function findProcessRun(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
    asyncOptions: AsyncProcessRunsHttpOptions,
    logging: RequestLoggingContext,
): Promise<void> {
    const caller = await resolveCaller(request, response, asyncOptions);
    if (!caller) return;

    let run: ProcessRunView | undefined;
    try {
        run = await asyncOptions.runs.find(runId, caller);
    } catch {
        writeAsyncUnavailable(response, asyncOptions);
        return;
    }
    if (!run) {
        writeFailureJson(
            response,
            404,
            "PROCESS_RUN_NOT_FOUND",
            "Process Run not found",
        );
        return;
    }

    response.setHeader("cache-control", "no-store");
    if (run.status === "queued" || run.status === "running") {
        response.setHeader(
            "retry-after",
            String(retryAfterSeconds(asyncOptions)),
        );
    }
    emitLog(logging, {
        event: "process_run_observed",
        timestamp: logging.clock.timestamp(),
        runId: run.runId,
        status: run.status,
        durationMs: elapsedMilliseconds(logging.clock, logging.startedAt),
    });
    writeJson(response, 200, run);
}

function writeBacklogLimit(
    response: ServerResponse,
    error: Extract<
        Extract<ProcessRunSubmission, { accepted: false }>["error"],
        {
            code:
                | "CALLER_BACKLOG_LIMIT_REACHED"
                | "ASYNC_SERVICE_CAPACITY_REACHED";
        }
    >,
    logging: RequestLoggingContext,
): void {
    const scope =
        error.code === "CALLER_BACKLOG_LIMIT_REACHED" ? "caller" : "global";
    const httpStatus = scope === "caller" ? 429 : 503;
    response.setHeader("retry-after", String(error.retryAfterSeconds));
    response.setHeader("cache-control", "no-store");
    emitLog(logging, {
        event: "process_run_admission_rejected",
        timestamp: logging.clock.timestamp(),
        scope,
        httpStatus,
        retryAfterSeconds: error.retryAfterSeconds,
        durationMs: elapsedMilliseconds(logging.clock, logging.startedAt),
    });
    writeFailureJson(response, httpStatus, error.code, error.message);
}

async function resolveCaller(
    request: IncomingMessage,
    response: ServerResponse,
    asyncOptions: AsyncProcessRunsHttpOptions,
) {
    try {
        const caller = await asyncOptions.callerIdentity.resolve(
            request.headers,
        );
        if (caller) return caller;
    } catch {
        writeAsyncUnavailable(response, asyncOptions);
        return undefined;
    }
    writeFailureJson(
        response,
        401,
        "CALLER_UNAUTHORIZED",
        "Caller identity could not be verified",
    );
    return undefined;
}

function writeAsyncUnavailable(
    response: ServerResponse,
    asyncOptions: AsyncProcessRunsHttpOptions,
): void {
    response.setHeader("retry-after", String(retryAfterSeconds(asyncOptions)));
    response.setHeader("cache-control", "no-store");
    writeFailureJson(
        response,
        503,
        "ASYNC_SERVICE_UNAVAILABLE",
        "Async Process Runs are temporarily unavailable",
    );
}

function retryAfterSeconds(options: AsyncProcessRunsHttpOptions): number {
    const value = options.retryAfterSeconds ?? 2;
    return Number.isInteger(value) && value > 0 ? value : 2;
}

function processRunIdFromPath(url: string | undefined): string | undefined {
    const match = /^\/process-runs\/([^/?#]+)$/.exec(url ?? "");
    if (!match?.[1]) return undefined;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return undefined;
    }
}

function rejectRequest(
    response: ServerResponse,
    failure: TransportFailure,
    logging: RequestLoggingContext,
): void {
    emitLog(logging, {
        event: "http_request_rejected",
        timestamp: logging.clock.timestamp(),
        httpStatus: failure.status,
        errorCode: failure.errorCode,
        durationMs: elapsedMilliseconds(logging.clock, logging.startedAt),
    });
    writeFailureJson(
        response,
        failure.status,
        failure.errorCode,
        failure.message,
    );
}

const systemClock: ProcessingClock = {
    timestamp: () => new Date().toISOString(),
    monotonicMilliseconds: () => performance.now(),
};

function writeStdoutLog(record: ProcessingLogRecord): void {
    console.log(JSON.stringify(record));
}

/**
 * Emits one record for the request being handled. Taking the logging context
 * rather than the sink keeps the caller's request id on every record without
 * each call site having to remember it.
 */
function emitLog(
    logging: RequestLoggingContext,
    record: ProcessingLogRecord,
): void {
    try {
        logging.logSink(
            logging.requestId === undefined
                ? record
                : { ...record, requestId: logging.requestId },
        );
    } catch {
        // Logging is best-effort and must not change the execution result.
    }
}

/**
 * Accepts only short, printable identifiers so a caller cannot inject
 * whitespace or control characters into single-line JSON logs. An unusable
 * value is dropped rather than rejected: the header never affects execution.
 */
function parseCallerRequestId(
    value: string | string[] | undefined,
): string | undefined {
    if (typeof value !== "string") return undefined;
    const candidate = value.trim();
    if (
        candidate.length === 0 ||
        candidate.length > maxCallerRequestIdLength ||
        !safeCallerRequestId.test(candidate)
    ) {
        return undefined;
    }
    return candidate;
}

function elapsedMilliseconds(
    clock: ProcessingClock,
    startedAt: number,
): number {
    return Math.max(0, Math.round(clock.monotonicMilliseconds() - startedAt));
}

function isJsonMediaType(value: string | undefined): boolean {
    return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

type ExecutionAdmissionController = Readonly<{
    tryAcquire: () => (() => void) | undefined;
    /** Live occupancy, so operators can see how close the service is to 503. */
    occupancy: () => Readonly<{ active: number; limit: number }>;
}>;

function createExecutionAdmissionController(
    maximum: number,
): ExecutionAdmissionController {
    let active = 0;
    return Object.freeze({
        tryAcquire: () => {
            if (active >= maximum) return undefined;
            active += 1;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                active -= 1;
            };
        },
        occupancy: () => Object.freeze({ active, limit: maximum }),
    });
}

async function readRequestBody(
    request: IncomingMessage,
    maxBytes: number,
): Promise<{ kind: "within_limit"; value: unknown } | { kind: "too_large" }> {
    const declaredLength = request.headers["content-length"];
    if (
        declaredLength !== undefined &&
        /^\d+$/.test(declaredLength) &&
        Number(declaredLength) > maxBytes
    ) {
        return { kind: "too_large" };
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += bytes.byteLength;
        if (receivedBytes > maxBytes) return { kind: "too_large" };
        chunks.push(bytes);
    }

    try {
        return {
            kind: "within_limit",
            value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
    } catch {
        return { kind: "within_limit", value: undefined };
    }
}

function statusFor(result: ProcessRunResult): number {
    if (result.status === "succeeded") return 200;

    const statuses: Record<ProcessErrorCode, number> = {
        AGENT_FAILURE: 502,
        DEPENDENCY_FAILURE: 502,
        DEPENDENCY_FAILURE_AFTER_COMMIT: 502,
        INTERNAL_ERROR: 500,
        INVALID_INPUT: 400,
        INVALID_OUTPUT: 500,
        PROCESS_NOT_FOUND: 404,
        PROCESS_TIMEOUT: 504,
    };
    return statuses[result.error.code];
}

function writeJson(
    response: ServerResponse,
    status: number,
    body: unknown,
): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

function writeFailureJson(
    response: ServerResponse,
    status: number,
    code: string,
    message: string,
): void {
    writeJson(response, status, {
        status: "failed",
        error: { code, message },
    });
}
