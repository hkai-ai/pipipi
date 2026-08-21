import { createHash } from "node:crypto";
import type {
    ProcessRunRecord,
    ProcessRunRecordAdapter,
} from "../process-runtime/records.js";
import { createJsonlDayFiles, utcDayOf } from "./day-files.js";

/**
 * A page of Run Records, newest first. `nextBefore` is an opaque cursor that
 * combines `recordedAt` and `runId`, so equal timestamps cannot skip a record.
 * It is absent once the archive has been read to its oldest retained record.
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
    errorCode?: string;
    /** Inclusive lower bound, as a canonical ISO 8601 instant. */
    since?: string;
    /** Exclusive upper bound, as a canonical ISO 8601 instant. */
    until?: string;
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
        const latest = new Map<string, ProcessRunRecord>();
        for (const file of await files.files()) {
            // Day files are named by UTC day, so a file entirely before the
            // window cannot contain a record inside it.
            if (
                file.slice(filePrefix.length, filePrefix.length + 10) <
                since.slice(0, 10)
            ) {
                continue;
            }
            const records = await files.read(file);
            for (let index = records.length - 1; index >= 0; index -= 1) {
                const record = records[index];
                if (record && !latest.has(record.runId)) {
                    latest.set(record.runId, record);
                }
            }
        }
        return [...latest.values()].filter(
            (record) => record.recordedAt >= since,
        );
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
        (query.status === undefined || record.status === query.status) &&
        (query.errorCode === undefined ||
            record.errorCode === query.errorCode) &&
        (query.since === undefined || record.recordedAt >= query.since) &&
        (query.until === undefined || record.recordedAt < query.until)
    );
}

function parseListLimit(value: number | undefined): number {
    if (value === undefined) return defaultProcessRunRecordListLimit;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("Run Record list limit must be a positive integer");
    }
    return Math.min(value, maximumProcessRunRecordListLimit);
}

type ProcessRunRecordCursor = Readonly<{
    recordedAt: string;
    runId?: string;
}>;

export function encodeProcessRunRecordCursor(
    record: Pick<ProcessRunRecord, "recordedAt" | "runId">,
): string {
    return `r1.${Buffer.from(
        JSON.stringify([record.recordedAt, record.runId]),
        "utf8",
    ).toString("base64url")}`;
}

export function parseProcessRunRecordCursor(
    value: string | undefined,
): ProcessRunRecordCursor | undefined {
    if (value === undefined) return undefined;
    if (!value.startsWith("r1.")) {
        const milliseconds = Date.parse(value);
        if (!Number.isFinite(milliseconds)) {
            throw new Error("Run Record cursor is invalid");
        }
        return Object.freeze({
            recordedAt: new Date(milliseconds).toISOString(),
        });
    }
    try {
        const decoded: unknown = JSON.parse(
            Buffer.from(value.slice(3), "base64url").toString("utf8"),
        );
        if (
            !Array.isArray(decoded) ||
            decoded.length !== 2 ||
            typeof decoded[0] !== "string" ||
            !Number.isFinite(Date.parse(decoded[0])) ||
            typeof decoded[1] !== "string" ||
            decoded[1].length === 0
        ) {
            throw new Error("invalid");
        }
        return Object.freeze({
            recordedAt: new Date(Date.parse(decoded[0])).toISOString(),
            runId: decoded[1],
        });
    } catch {
        throw new Error("Run Record cursor is invalid");
    }
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
