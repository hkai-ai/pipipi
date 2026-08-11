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

/**
 * Submits a real Business Process execution. This is the one call that costs
 * money, so it is deliberately the only non-GET the console makes.
 */
export async function execute(
    process: string,
    input: Record<string, unknown>,
): Promise<ExecutionOutcome> {
    const response = await fetch(new URL("/execute", document.baseURI), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ process, version: "v1", input }),
    });
    return { httpStatus: response.status, body: await response.json() };
}
