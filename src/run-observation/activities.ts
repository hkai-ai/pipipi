/** Attempt 活动归档 Interface */
import type {
    ProcessRunLogRecord,
    ProcessRunLogSink,
} from "../process-runtime/index.js";

export type OpenRun = Readonly<{
    runId: string;
    process: string;
    version: string;
    startedAt: string;
}>;

export const openRunLimit = 100;

/**
 * The durable half of the activity log.
 *
 * The same records Pino writes to stdout are appended here, so an operator can
 * still reconstruct an Attempt timeline after the container that produced it
 * has been replaced. Adapters project permitted fields and sanitize diagnostics
 * so records carry no business content. `jsonl.ts` and `postgres.ts` are the two
 * Adapters.
 */
export type ProcessRunActivityArchive = Readonly<{
    listOpen: (since: string) => Promise<readonly OpenRun[]>;
    record: ProcessRunLogSink;
    /** Waits for writes already accepted by this process; failures are isolated. */
    flush: () => Promise<void>;
    /** One Run's records, in the order they were emitted. */
    findByRun: (runId: string) => Promise<readonly ProcessRunLogRecord[]>;
}>;

export const defaultProcessRunActivityRetentionDays = 30;
