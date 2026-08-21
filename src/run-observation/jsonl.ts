import type {
    ProcessRunLogRecord,
    ProcessRunLogSink,
} from "../process-runtime/index.js";
import type { ProcessRunRecord } from "../process-runtime/records.js";
import {
    defaultProcessRunActivityRetentionDays,
    type ProcessRunActivityArchive,
} from "./activities.js";
import { createJsonlDayFiles, utcDayOf } from "./day-files.js";
import {
    defaultProcessRunRecordRetentionDays,
    encodeProcessRunRecordCursor,
    type ProcessRunRecordArchive,
    type ProcessRunRecordCursor,
    type ProcessRunRecordQuery,
    parseProcessRunRecordCursor,
    parseProcessRunRecordListLimit,
    redactProcessRunRecord,
} from "./records.js";
import {
    attemptDurationsOf,
    type RunObservationStats,
    summariseRunObservation,
} from "./stats.js";

/**
 * File-backed Run observation: one JSON object per line, one file per UTC day,
 * under a directory that outlives the container. Chosen for single-instance
 * deployments without a database; the PostgreSQL Adapter in `postgres.ts`
 * satisfies the same Interfaces.
 */

type JsonlOptions = Readonly<{
    directory: string;
    retentionDays?: number;
    clock?: () => Date;
}>;

const recordFilePrefix = "runs-";
const activityFilePrefix = "activities-";

export function createJsonlProcessRunRecordArchive(
    options: JsonlOptions,
): ProcessRunRecordArchive {
    const clock = options.clock ?? (() => new Date());
    const files = createRecordDayFiles(options, clock);

    return Object.freeze({
        store: (record) =>
            files.append(
                utcDayOf(record.recordedAt, clock),
                redactProcessRunRecord(record),
            ),

        find: async (runId) => {
            for (const file of await files.files()) {
                // Later lines win: a replayed runId reflects its latest outcome.
                const match = (await files.read(file)).findLast(
                    (record) => record.runId === runId,
                );
                if (match) return match;
            }
            return undefined;
        },

        list: async (query = {}) => {
            const limit = parseProcessRunRecordListLimit(query.limit);
            const before = parseProcessRunRecordCursor(query.before);
            const latest = new Map<string, ProcessRunRecord>();

            for (const file of await files.files()) {
                const records = await files.read(file);
                for (let index = records.length - 1; index >= 0; index -= 1) {
                    const record = records[index];
                    if (!record) continue;
                    if (!latest.has(record.runId))
                        latest.set(record.runId, record);
                }
            }
            const matching = [...latest.values()]
                .filter(
                    (record) =>
                        matchesFilters(record, query) &&
                        comesBeforeCursor(record, before),
                )
                .sort(
                    (left, right) =>
                        right.recordedAt.localeCompare(left.recordedAt) ||
                        right.runId.localeCompare(left.runId),
                );
            const records = Object.freeze(matching.slice(0, limit));
            const last = records.at(-1);
            return Object.freeze(
                matching.length > limit && last
                    ? {
                          records,
                          nextBefore: encodeProcessRunRecordCursor(last),
                      }
                    : { records },
            );
        },
    });
}

export function createJsonlProcessRunActivityArchive(
    options: JsonlOptions,
): ProcessRunActivityArchive {
    const clock = options.clock ?? (() => new Date());
    const files = createActivityDayFiles(options, clock);

    const record: ProcessRunLogSink = (entry) => {
        // Persisting is best effort: it happens off the response path and
        // must never change a Process Run's result.
        void files
            .append(utcDayOf(entry.timestamp, clock), entry)
            .catch(() => {});
    };

    return Object.freeze({
        record,

        flush: () => files.flush().catch(() => {}),

        findByRun: async (runId) => {
            const matches: ProcessRunLogRecord[] = [];
            // Newest day first, so stop as soon as a day contributed nothing
            // after an earlier one already matched: a Run cannot span a gap.
            for (const file of await files.files()) {
                const found = (await files.read(file)).filter(
                    (entry) => entry.runId === runId,
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

/**
 * The window is scanned on every request: at the volume a single synchronous
 * instance can produce, a full scan of the retained window is milliseconds,
 * and a cache would only add a staleness question.
 */
export function createJsonlRunObservationStats(
    options: JsonlOptions,
): RunObservationStats {
    const clock = options.clock ?? (() => new Date());
    const records = createRecordDayFiles(options, clock);
    const activities = createActivityDayFiles(options, clock);
    return Object.freeze({
        summarise: async ({ since }) =>
            summariseRunObservation({
                since,
                records: await latestRecordsSince(records, since),
                attemptDurationsMs: attemptDurationsOf(
                    await activitiesSince(activities, since),
                    since,
                ),
            }),
    });
}

/**
 * Deletes day files outside the retention window. Called at startup so the
 * volume cannot grow without bound; it is best effort and never blocks the
 * service from listening.
 */
export async function pruneProcessRunRecords(
    options: JsonlOptions,
): Promise<void> {
    const clock = options.clock ?? (() => new Date());
    await createRecordDayFiles(options, clock).prune();
}

export async function pruneProcessRunActivities(
    options: JsonlOptions,
): Promise<void> {
    const clock = options.clock ?? (() => new Date());
    await createActivityDayFiles(options, clock).prune();
}

type DayFiles<Value> = ReturnType<typeof createJsonlDayFiles<Value>>;

function createRecordDayFiles(
    options: JsonlOptions,
    clock: () => Date,
): DayFiles<ProcessRunRecord> {
    return createJsonlDayFiles<ProcessRunRecord>({
        directory: options.directory,
        prefix: recordFilePrefix,
        retentionDays: retentionDaysOf(
            options.retentionDays,
            defaultProcessRunRecordRetentionDays,
        ),
        clock,
        parse: (value) => (isProcessRunRecord(value) ? value : undefined),
    });
}

function createActivityDayFiles(
    options: JsonlOptions,
    clock: () => Date,
): DayFiles<ProcessRunLogRecord> {
    return createJsonlDayFiles<ProcessRunLogRecord>({
        directory: options.directory,
        prefix: activityFilePrefix,
        retentionDays: retentionDaysOf(
            options.retentionDays,
            defaultProcessRunActivityRetentionDays,
        ),
        clock,
        parse: (value) => (isActivityRecord(value) ? value : undefined),
    });
}

function retentionDaysOf(value: number | undefined, fallback: number): number {
    const retentionDays = value ?? fallback;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
        throw new Error(
            "PROCESS_RUN_RECORD_RETENTION_DAYS must be a positive integer",
        );
    }
    return retentionDays;
}

/** Day files are named by UTC day, so a file entirely before `since` is skipped. */
function fileIsBefore(file: string, prefix: string, since: string): boolean {
    return file.slice(prefix.length, prefix.length + 10) < since.slice(0, 10);
}

/**
 * Every record recorded at or after `since`, latest line per Run. Aggregation
 * reads the window whole rather than paging it, because a summary has no
 * cursor to resume from.
 */
async function latestRecordsSince(
    files: DayFiles<ProcessRunRecord>,
    since: string,
): Promise<ProcessRunRecord[]> {
    const latest = new Map<string, ProcessRunRecord>();
    for (const file of await files.files()) {
        if (fileIsBefore(file, recordFilePrefix, since)) continue;
        const records = await files.read(file);
        for (let index = records.length - 1; index >= 0; index -= 1) {
            const record = records[index];
            if (record && !latest.has(record.runId)) {
                latest.set(record.runId, record);
            }
        }
    }
    return [...latest.values()].filter((record) => record.recordedAt >= since);
}

async function activitiesSince(
    files: DayFiles<ProcessRunLogRecord>,
    since: string,
): Promise<ProcessRunLogRecord[]> {
    const found: ProcessRunLogRecord[] = [];
    for (const file of await files.files()) {
        if (fileIsBefore(file, activityFilePrefix, since)) continue;
        for (const record of await files.read(file)) {
            if (record.timestamp >= since) found.push(record);
        }
    }
    return found;
}

function matchesFilters(
    record: ProcessRunRecord,
    query: ProcessRunRecordQuery,
): boolean {
    return (
        (query.process === undefined || record.process === query.process) &&
        (query.status === undefined || record.status === query.status) &&
        (query.errorCode === undefined ||
            record.errorCode === query.errorCode) &&
        (query.since === undefined || record.recordedAt >= query.since) &&
        (query.until === undefined || record.recordedAt < query.until)
    );
}

function comesBeforeCursor(
    record: ProcessRunRecord,
    cursor: ProcessRunRecordCursor | undefined,
): boolean {
    if (!cursor) return true;
    if (record.recordedAt !== cursor.recordedAt) {
        return record.recordedAt < cursor.recordedAt;
    }
    return cursor.runId !== undefined && record.runId < cursor.runId;
}

function isProcessRunRecord(value: unknown): value is ProcessRunRecord {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        candidate.schemaVersion === 1 &&
        typeof candidate.recordedAt === "string" &&
        typeof candidate.runId === "string" &&
        (candidate.status === "succeeded" || candidate.status === "failed")
    );
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
