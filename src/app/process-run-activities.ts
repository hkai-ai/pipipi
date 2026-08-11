import type {
    ProcessRunLogRecord,
    ProcessRunLogSink,
} from "../process-runtime/index.js";
import { createJsonlDayFiles, utcDayOf } from "./jsonl-day-files.js";

/**
 * The durable half of the activity log.
 *
 * The same records Pino writes to stdout are appended here, so an operator can
 * still reconstruct an Attempt timeline after the container that produced it
 * has been replaced. Activity records carry no business content by design, so
 * nothing is redacted on the way in.
 */
export type ProcessRunActivityArchive = Readonly<{
    record: ProcessRunLogSink;
    /** One Run's records, in the order they were emitted. */
    findByRun: (runId: string) => Promise<readonly ProcessRunLogRecord[]>;
}>;

export const defaultProcessRunActivityRetentionDays = 30;

const filePrefix = "activities-";

export function createJsonlProcessRunActivityArchive(options: {
    directory: string;
    retentionDays?: number;
    clock?: () => Date;
}): ProcessRunActivityArchive {
    const clock = options.clock ?? (() => new Date());
    const files = createActivityDayFiles(options, clock);

    return Object.freeze({
        record: (record) => {
            // Persisting is best effort: it happens off the response path and
            // must never change a Process Run's result.
            void files
                .append(utcDayOf(record.timestamp, clock), record)
                .catch(() => {});
        },

        findByRun: async (runId) => {
            const matches: ProcessRunLogRecord[] = [];
            // Newest day first, so stop as soon as a day contributed nothing
            // after an earlier one already matched: a Run cannot span a gap.
            for (const file of await files.files()) {
                const found = (await files.read(file)).filter(
                    (record) => record.runId === runId,
                );
                if (found.length === 0) {
                    if (matches.length > 0) break;
                    continue;
                }
                matches.unshift(...found);
            }
            return Object.freeze(
                matches.sort(
                    (left, right) =>
                        left.attemptNumber - right.attemptNumber ||
                        left.sequence - right.sequence,
                ),
            );
        },
    });
}

export async function pruneProcessRunActivities(options: {
    directory: string;
    retentionDays?: number;
    clock?: () => Date;
}): Promise<void> {
    const clock = options.clock ?? (() => new Date());
    await createActivityDayFiles(options, clock).prune();
}

function createActivityDayFiles(
    options: { directory: string; retentionDays?: number },
    clock: () => Date,
) {
    const retentionDays =
        options.retentionDays ?? defaultProcessRunActivityRetentionDays;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
        throw new Error(
            "PROCESS_RUN_RECORD_RETENTION_DAYS must be a positive integer",
        );
    }
    return createJsonlDayFiles<ProcessRunLogRecord>({
        directory: options.directory,
        prefix: filePrefix,
        retentionDays,
        clock,
        parse: (value) => (isActivityRecord(value) ? value : undefined),
    });
}

function isActivityRecord(value: unknown): value is ProcessRunLogRecord {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        candidate.schemaVersion === 1 &&
        typeof candidate.timestamp === "string" &&
        typeof candidate.runId === "string" &&
        typeof candidate.event === "string" &&
        Number.isSafeInteger(candidate.attemptNumber) &&
        Number.isSafeInteger(candidate.sequence)
    );
}
