import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
    ProcessRunRecord,
    ProcessRunRecordAdapter,
} from "../process-runtime/records.js";

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
const fileSuffix = ".jsonl";
const dayFilePattern = /^runs-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Stores Run Records as one JSON object per line, in a file per UTC day, under
 * a directory that outlives the container. Daily files keep both retention and
 * reads bounded: pruning is a file delete, and a list only parses as many days
 * as the requested page needs.
 */
export function createJsonlProcessRunRecordArchive(options: {
    directory: string;
    retentionDays?: number;
    clock?: () => Date;
}): ProcessRunRecordArchive {
    const directory = options.directory;
    const retentionDays =
        options.retentionDays ?? defaultProcessRunRecordRetentionDays;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
        throw new Error(
            "PROCESS_RUN_RECORD_RETENTION_DAYS must be a positive integer",
        );
    }
    const clock = options.clock ?? (() => new Date());

    // Appends are serialized so two concurrent runs cannot interleave partial
    // lines in the same file. Only this process writes the archive.
    let pendingWrite: Promise<void> = Promise.resolve();

    return Object.freeze({
        store: (record) => {
            const line = `${JSON.stringify(redactRecord(record))}\n`;
            const file = dayFile(directory, record.recordedAt, clock);
            pendingWrite = pendingWrite.then(async () => {
                await mkdir(directory, { recursive: true });
                await appendFile(file, line, "utf8");
            });
            return pendingWrite;
        },

        find: async (runId) => {
            for (const file of await retainedFiles(
                directory,
                clock,
                retentionDays,
            )) {
                const records = await readRecords(join(directory, file));
                // Later lines win: a replayed runId reflects its latest outcome.
                const match = records.findLast(
                    (record) => record.runId === runId,
                );
                if (match) return match;
            }
            return undefined;
        },

        list: async (query = {}) => {
            const limit = parseListLimit(query.limit);
            const before = query.before;
            const files = await retainedFiles(directory, clock, retentionDays);
            const page: ProcessRunRecord[] = [];

            for (const file of files) {
                const records = await readRecords(join(directory, file));
                for (let index = records.length - 1; index >= 0; index -= 1) {
                    const record = records[index];
                    if (!record) continue;
                    if (before !== undefined && record.recordedAt >= before) {
                        continue;
                    }
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
 * Deletes day files outside the retention window. Called at startup so the
 * volume cannot grow without bound; it is best effort and never blocks the
 * service from listening.
 */
export async function pruneProcessRunRecords(options: {
    directory: string;
    retentionDays?: number;
    clock?: () => Date;
}): Promise<void> {
    const retentionDays =
        options.retentionDays ?? defaultProcessRunRecordRetentionDays;
    const clock = options.clock ?? (() => new Date());
    const cutoff = retentionCutoff(clock, retentionDays);
    for (const file of await listDayFiles(options.directory)) {
        const day = dayFilePattern.exec(file)?.[1];
        if (day !== undefined && day < cutoff) {
            await rm(join(options.directory, file), { force: true });
        }
    }
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
 */
function redactRecord(record: ProcessRunRecord): ProcessRunRecord {
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

function dayFile(
    directory: string,
    recordedAt: string,
    clock: () => Date,
): string {
    const day = utcDay(recordedAt) ?? utcDay(clock().toISOString());
    return join(directory, `${filePrefix}${day}${fileSuffix}`);
}

function utcDay(timestamp: string): string | undefined {
    const day = timestamp.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

/** Day files inside the retention window, newest day first. */
async function retainedFiles(
    directory: string,
    clock: () => Date,
    retentionDays: number,
): Promise<readonly string[]> {
    const cutoff = retentionCutoff(clock, retentionDays);
    return (await listDayFiles(directory)).filter((file) => {
        const day = dayFilePattern.exec(file)?.[1];
        return day !== undefined && day >= cutoff;
    });
}

async function listDayFiles(directory: string): Promise<string[]> {
    try {
        const entries = await readdir(directory);
        return entries
            .filter((entry) => dayFilePattern.test(entry))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

function retentionCutoff(clock: () => Date, retentionDays: number): string {
    const cutoff = new Date(
        clock().getTime() - (retentionDays - 1) * 86_400_000,
    );
    return cutoff.toISOString().slice(0, 10);
}

/**
 * Reads one day file, oldest line first. A truncated or hand-edited line is
 * skipped rather than failing the read: an operator view must still open when
 * a single record is unreadable.
 */
async function readRecords(file: string): Promise<ProcessRunRecord[]> {
    let contents: string;
    try {
        contents = await readFile(file, "utf8");
    } catch {
        return [];
    }
    const records: ProcessRunRecord[] = [];
    for (const line of contents.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
            const value: unknown = JSON.parse(line);
            if (isProcessRunRecord(value)) records.push(value);
        } catch {
            // Skip an unreadable line.
        }
    }
    return records;
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
