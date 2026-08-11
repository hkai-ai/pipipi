import { createHash } from "node:crypto";
import type {
    ProcessRunRecord,
    ProcessRunRecordAdapter,
} from "../process-runtime/records.js";
import { createJsonlDayFiles, utcDayOf } from "./jsonl-day-files.js";

/**
 * A page of Run Records, newest first. `nextBefore` is the `recordedAt` to pass
 * back as `before` to continue reading older records; it is absent once the
 * archive has been read to its oldest retained record.
 */
export type ProcessRunRecordPage = Readonly<{
    records: readonly ProcessRunRecord[];
    nextBefore?: string;
}>;

export type ProcessRunRecordQuery = Readonly<{
    limit?: number;
    before?: string;
    process?: string;
    status?: "succeeded" | "failed";
}>;

/**
 * A durable Run Record Adapter that can also be read back as a list.
 *
 * This is deliberately not the async Run Store: it holds observed outcomes for
 * operators to look at, never the queued/running lifecycle, and nothing reads
 * it to decide business state, retries or delivery.
 */
export type ProcessRunRecordArchive = ProcessRunRecordAdapter &
    Readonly<{
        list: (query?: ProcessRunRecordQuery) => Promise<ProcessRunRecordPage>;
    }>;

export const defaultProcessRunRecordRetentionDays = 30;
export const defaultProcessRunRecordListLimit = 50;
export const maximumProcessRunRecordListLimit = 200;

const filePrefix = "runs-";

/**
 * Stores Run Records as one JSON object per line, in a file per UTC day, under
 * a directory that outlives the container.
 */
export function createJsonlProcessRunRecordArchive(options: {
    directory: string;
    retentionDays?: number;
    clock?: () => Date;
}): ProcessRunRecordArchive {
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
            const limit = parseListLimit(query.limit);
            const before = query.before;
            const page: ProcessRunRecord[] = [];

            for (const file of await files.files()) {
                const records = await files.read(file);
                for (let index = records.length - 1; index >= 0; index -= 1) {
                    const record = records[index];
                    if (!record) continue;
                    if (before !== undefined && record.recordedAt >= before) {
                        continue;
                    }
                    if (!matchesFilters(record, query)) continue;
                    page.push(record);
                    if (page.length > limit) {
                        return Object.freeze({
                            records: Object.freeze(page.slice(0, limit)),
                            nextBefore: page[limit - 1]?.recordedAt,
                        });
                    }
                }
            }
            return Object.freeze({ records: Object.freeze(page) });
        },
    });
}

/**
 * Every record recorded at or after `since`. Aggregation reads the window whole
 * rather than paging it, because a summary has no cursor to resume from.
 */
export function createJsonlProcessRunRecordReader(options: {
    directory: string;
    retentionDays?: number;
    clock?: () => Date;
}): (since: string) => Promise<ProcessRunRecord[]> {
    const clock = options.clock ?? (() => new Date());
    const files = createRecordDayFiles(options, clock);
    return async (since) => {
        const found: ProcessRunRecord[] = [];
        for (const file of await files.files()) {
            // Day files are named by UTC day, so a file entirely before the
            // window cannot contain a record inside it.
            if (
                file.slice(filePrefix.length, filePrefix.length + 10) <
                since.slice(0, 10)
            ) {
                continue;
            }
            for (const record of await files.read(file)) {
                if (record.recordedAt >= since) found.push(record);
            }
        }
        return found;
    };
}

/**
 * Deletes day files outside the retention window. Called at startup so the
 * volume cannot grow without bound; it is best effort and never blocks the
 * service from listening.
 */
export async function pruneProcessRunRecords(options: {
    directory: string;
    retentionDays?: number;
    clock?: () => Date;
}): Promise<void> {
    const clock = options.clock ?? (() => new Date());
    await createRecordDayFiles(options, clock).prune();
}

export function parseProcessRunRecordContent(
    value: string | undefined,
): "omit" | "accepted-input-and-output" {
    if (value === undefined || value === "omit") return "omit";
    if (value === "accepted-input-and-output") return value;
    throw new Error(
        "PROCESS_RUN_RECORD_CONTENT must be omit or accepted-input-and-output",
    );
}

function createRecordDayFiles(
    options: { directory: string; retentionDays?: number },
    clock: () => Date,
) {
    const retentionDays =
        options.retentionDays ?? defaultProcessRunRecordRetentionDays;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
        throw new Error(
            "PROCESS_RUN_RECORD_RETENTION_DAYS must be a positive integer",
        );
    }
    return createJsonlDayFiles<ProcessRunRecord>({
        directory: options.directory,
        prefix: filePrefix,
        retentionDays,
        clock,
        parse: (value) => (isProcessRunRecord(value) ? value : undefined),
    });
}

function matchesFilters(
    record: ProcessRunRecord,
    query: ProcessRunRecordQuery,
): boolean {
    return (
        (query.process === undefined || record.process === query.process) &&
        (query.status === undefined || record.status === query.status)
    );
}

function parseListLimit(value: number | undefined): number {
    if (value === undefined) return defaultProcessRunRecordListLimit;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("Run Record list limit must be a positive integer");
    }
    return Math.min(value, maximumProcessRunRecordListLimit);
}

/**
 * `crt-interface-image` accepts a public reference URL, and a full source URL
 * must not reach a log or a stored record. The record keeps a digest so the
 * same source is still recognisable across runs.
 *
 * Every Run Record Adapter applies this before writing, so the boundary holds
 * no matter which storage a deployment chooses.
 */
export function redactProcessRunRecord(
    record: ProcessRunRecord,
): ProcessRunRecord {
    const input = record.content?.input;
    if (
        record.process !== "crt-interface-image" ||
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input) ||
        !("sourceImageUrl" in input) ||
        typeof input.sourceImageUrl !== "string"
    ) {
        return record;
    }
    const { sourceImageUrl, ...rest } = input as Record<string, unknown> & {
        sourceImageUrl: string;
    };
    return {
        ...record,
        content: {
            ...record.content,
            input: {
                ...rest,
                sourceImageUrlSha256: createHash("sha256")
                    .update(sourceImageUrl, "utf8")
                    .digest("hex"),
            },
        },
    };
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
