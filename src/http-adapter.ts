import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import type {
  ProcessErrorCode,
  ProcessExecutor,
  ProcessRunResult,
} from "./process-runtime.js";
import {
  defaultHttpMaxRequestBodyBytes,
  defaultMaxConcurrentExecutions,
} from "./http-config.js";

export type ProcessingHttpOptions = {
  maxRequestBodyBytes?: number;
  maxConcurrentExecutions?: number;
  logSink?: ProcessingLogSink;
  clock?: ProcessingClock;
};

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
};

export type ProcessingLogRecord =
  | ProcessRunCompletedLogRecord
  | HttpRequestRejectedLogRecord;

export type ProcessingLogSink = (record: ProcessingLogRecord) => void;

type RequestLoggingContext = {
  logSink: ProcessingLogSink;
  clock: ProcessingClock;
  startedAt: number;
};

type RequestHandlingContext = {
  executor: ProcessExecutor;
  maxRequestBodyBytes: number;
  tryAcquireExecution: () => (() => void) | undefined;
  logging: RequestLoggingContext;
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
  const tryAcquireExecution = createExecutionAdmissionController(
    maxConcurrentExecutions,
  );
  return (request, response) => {
    const context: RequestHandlingContext = {
      executor,
      maxRequestBodyBytes,
      tryAcquireExecution,
      logging: {
        logSink,
        clock,
        startedAt: clock.monotonicMilliseconds(),
      },
    };
    void handleRequest(request, response, context).catch(() => {
      emitLog(context.logging.logSink, {
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

  const releaseExecution = context.tryAcquireExecution();
  if (!releaseExecution) {
    response.setHeader("retry-after", "1");
    rejectRequest(response, serviceBusyFailure, context.logging);
    return;
  }

  try {
    const result = await context.executor.execute(requestBody.value);
    emitLog(context.logging.logSink, {
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

function rejectRequest(
  response: ServerResponse,
  failure: TransportFailure,
  logging: RequestLoggingContext,
): void {
  emitLog(logging.logSink, {
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

function emitLog(logSink: ProcessingLogSink, record: ProcessingLogRecord): void {
  try {
    logSink(record);
  } catch {
    // Logging is best-effort and must not change the execution result.
  }
}

function elapsedMilliseconds(clock: ProcessingClock, startedAt: number): number {
  return Math.max(0, Math.round(clock.monotonicMilliseconds() - startedAt));
}

function isJsonMediaType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function createExecutionAdmissionController(
  maximum: number,
): () => (() => void) | undefined {
  let active = 0;
  return () => {
    if (active >= maximum) return undefined;
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
    };
  };
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<
  { kind: "within_limit"; value: unknown } | { kind: "too_large" }
> {
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
