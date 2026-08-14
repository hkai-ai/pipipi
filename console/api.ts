import type {
    ConsoleProcessDescription,
    ConsoleStats,
} from "../src/api/http.js";
import type { ProcessRunLogRecord } from "../src/process-runtime/logging.js";
import type { ProcessRunRecord } from "../src/process-runtime/records.js";

/**
 * The console reads the server's own types. They are type-only imports, erased
 * at build time, so no server code reaches the browser — but the page and the
 * API can no longer disagree about the shape of a record, a timeline entry or a
 * summary.
 */
export type {
    ConsoleProcessDescription,
    ConsoleStats,
    ProcessRunLogRecord,
    ProcessRunRecord,
};

export type RunRecordPage = Readonly<{
    records: readonly ProcessRunRecord[];
    nextBefore?: string;
}>;

export type RunTimeline = Readonly<{
    runId: string;
    activities: readonly ProcessRunLogRecord[];
}>;

export type RunFilters = Readonly<{
    process?: string;
    status?: "succeeded" | "failed";
}>;

/**
 * Requests resolve against the document's `<base>`, which the server sets to
 * the deployed console path. Nothing here hard-codes `/console`.
 */
async function readJson<Result>(path: string): Promise<Result> {
    const response = await fetch(new URL(path, document.baseURI), {
        headers: { accept: "application/json" },
    });
    if (!response.ok) {
        throw new Error(`请求失败：HTTP ${response.status}`);
    }
    return (await response.json()) as Result;
}

export function listRuns(
    options: Readonly<{ limit?: number; before?: string }> & RunFilters,
): Promise<RunRecordPage> {
    const query = new URLSearchParams({
        limit: String(options.limit ?? 50),
    });
    if (options.before) query.set("before", options.before);
    if (options.process) query.set("process", options.process);
    if (options.status) query.set("status", options.status);
    return readJson(`runs?${query.toString()}`);
}

export function findRun(runId: string): Promise<ProcessRunRecord> {
    return readJson(`runs/${encodeURIComponent(runId)}`);
}

export function findTimeline(runId: string): Promise<RunTimeline> {
    return readJson(`runs/${encodeURIComponent(runId)}/activities`);
}

export function listProcesses(): Promise<
    Readonly<{ processes: readonly ConsoleProcessDescription[] }>
> {
    return readJson("processes");
}

export function readStats(hours: number): Promise<ConsoleStats> {
    return readJson(`stats?hours=${hours}`);
}

export type ExecutionOutcome = Readonly<{
    httpStatus: number;
    body: unknown;
}>;

export const defaultExecutionTimeoutMs = 300_000;

type ExecutionOptions = Readonly<{
    timeoutMs?: number;
    onAccepted?: (runId: string) => void;
}>;

/**
 * Submits one durable Process Run, then follows the owner-scoped result
 * location until the Run reaches a terminal state. The browser timeout stops
 * polling only; it never cancels the accepted Run.
 */
export async function executeAsync(
    process: string,
    version: string,
    input: Record<string, unknown>,
    options: ExecutionOptions = {},
): Promise<ExecutionOutcome> {
    const timeoutMs = options.timeoutMs ?? defaultExecutionTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error("异步结果等待超时必须是正整数");
    }

    const submission = await fetch(new URL("/process-runs", document.baseURI), {
        method: "POST",
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ process, version, input }),
    });
    const submissionBody = await submission.json();
    if (submission.status !== 202) {
        return { httpStatus: submission.status, body: submissionBody };
    }

    const runId = readRunId(submissionBody);
    const location = submission.headers.get("location");
    if (!location) {
        throw new Error("异步提交响应缺少结果地址");
    }
    options.onAccepted?.(runId);

    const deadline = Date.now() + timeoutMs;
    let retryAfterMs = readRetryAfterMs(submission);
    for (;;) {
        await waitToPoll(retryAfterMs, deadline, runId, timeoutMs);
        const response = await fetch(new URL(location, document.baseURI), {
            headers: { accept: "application/json" },
        });
        const body = await response.json();
        if (!response.ok) {
            return { httpStatus: response.status, body };
        }
        if (isTerminalRun(body)) {
            return { httpStatus: response.status, body };
        }
        retryAfterMs = readRetryAfterMs(response);
    }
}

function readRunId(value: unknown): string {
    if (
        typeof value === "object" &&
        value !== null &&
        "runId" in value &&
        typeof value.runId === "string"
    ) {
        return value.runId;
    }
    throw new Error("异步提交响应缺少 runId");
}

function isTerminalRun(value: unknown): boolean {
    if (typeof value !== "object" || value === null || !("status" in value)) {
        return false;
    }
    return value.status === "succeeded" || value.status === "failed";
}

function readRetryAfterMs(response: Response): number {
    const seconds = Number(response.headers.get("retry-after") ?? "2");
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 2_000;
}

async function waitToPoll(
    retryAfterMs: number,
    deadline: number,
    runId: string,
    timeoutMs: number,
): Promise<void> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw resultTimeout(runId, timeoutMs);
    await new Promise((resolve) =>
        setTimeout(resolve, Math.min(retryAfterMs, remainingMs)),
    );
    if (Date.now() >= deadline) throw resultTimeout(runId, timeoutMs);
}

function resultTimeout(runId: string, timeoutMs: number): Error {
    return new Error(
        `等待异步结果超过 ${timeoutMs / 1_000} 秒；Run ${runId} 仍会在服务端继续执行`,
    );
}
