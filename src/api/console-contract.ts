/** 定义控制台共享的只读响应与运行记录筛选合同。 */
import type { RunObservationSummary } from "../run-observation/stats.js";

export type { ProcessRunLogRecord } from "../process-runtime/logging.js";
export type { ProcessRunRecord } from "../process-runtime/records.js";
export type {
    ProcessRunRecordPage as RunRecordPage,
    ProcessRunRecordQuery as RunFilters,
} from "../run-observation/records.js";

/**
 * The observation summary as the console receives it; `run-observation` owns
 * the shape. Live concurrency is added below, because occupancy exists only in
 * the process serving the request.
 */
export type ConsoleStatsSummary = RunObservationSummary;

export type ConsoleStats = ConsoleStatsSummary &
    Readonly<{
        until?: string;
        generatedAt?: string;
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
    skills: readonly Readonly<{ name: string; version: string }>[];
    activities: readonly string[];
    retry: Readonly<{
        maximumAttempts: number;
        retryableErrorCodes: readonly string[];
    }>;
    input?: unknown;
    output?: unknown;
}>;

/**
 * How one installed Runtime Skill is described to operators. Entries come from
 * the exact bindings the production Processes were built with, so the list
 * cannot name a Skill the release does not ship. `instructions` is the
 * reviewed `SKILL.md` body the Agent receives; `cover` is present only when
 * the snapshot ships a cover image beside `SKILL.md`.
 */
export type ConsoleSkillDescription = Readonly<{
    name: string;
    version: string;
    sha256: string;
    description: string;
    /** Process ids whose Registration binds this exact version. */
    processes: readonly string[];
    instructions: string;
    /** Every file in the snapshot, as POSIX paths relative to its directory. */
    files: readonly string[];
    cover?: Readonly<{ file: string; mediaType: string }>;
    /** Provenance notes from `SOURCE.md`, when the snapshot carries them. */
    source?: string;
}>;
