import type {
    ConsoleProcessDescription,
    ConsoleSkillDescription,
    ConsoleStats,
    ProcessRunLogRecord,
    ProcessRunRecord,
    RunFilters,
    RunRecordPage,
} from "../src/api/console-contract.js";

export type {
    ConsoleProcessDescription,
    ConsoleSkillDescription,
    ConsoleStats,
    ProcessRunLogRecord,
    ProcessRunRecord,
    RunFilters,
    RunRecordPage,
};

export type RunTimeline = Readonly<{
    runId: string;
    activities: readonly ProcessRunLogRecord[];
    queue?: import("../src/process-runs/ops/queue-state.js").RunQueueState;
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
    if (options.version) query.set("version", options.version);
    if (options.process) query.set("process", options.process);
    if (options.status) query.set("status", options.status);
    if (options.errorCode) query.set("errorCode", options.errorCode);
    if (options.since) query.set("since", options.since);
    if (options.until) query.set("until", options.until);
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

export function listSkills(): Promise<
    Readonly<{ skills: readonly ConsoleSkillDescription[] }>
> {
    return readJson("skills");
}

/**
 * The cover is an ordinary same-origin image URL so the browser caches it and
 * `<img>` can load it lazily; it resolves against the same `<base>` as the
 * JSON routes.
 */
export function skillCoverHref(
    skill: Pick<ConsoleSkillDescription, "name" | "version">,
): string {
    return new URL(
        `skills/${encodeURIComponent(`${skill.name}@${skill.version}`)}/cover`,
        document.baseURI,
    ).toString();
}
