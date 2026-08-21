/** Run Record 归档 Interface，以及两套 Adapter 共用的游标、分页上限、净化和聚合规则 */
import { createHash } from "node:crypto";
import type {
    ProcessRunRecord,
    ProcessRunRecordAdapter,
} from "../process-runtime/records.js";

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
 * it to decide business state, retries or delivery. `jsonl.ts` and
 * `postgres.ts` are the two Adapters; the cursor, limit and redaction rules
 * below are shared so the two cannot disagree.
 */
export type ProcessRunRecordArchive = ProcessRunRecordAdapter &
    Readonly<{
        list: (query?: ProcessRunRecordQuery) => Promise<ProcessRunRecordPage>;
    }>;

export const defaultProcessRunRecordRetentionDays = 30;
export const defaultProcessRunRecordListLimit = 50;
export const maximumProcessRunRecordListLimit = 200;

export function parseProcessRunRecordContent(
    value: string | undefined,
): "omit" | "accepted-input-and-output" {
    if (value === undefined || value === "omit") return "omit";
    if (value === "accepted-input-and-output") return value;
    throw new Error(
        "PROCESS_RUN_RECORD_CONTENT must be omit or accepted-input-and-output",
    );
}

export function parseProcessRunRecordListLimit(
    value: number | undefined,
): number {
    if (value === undefined) return defaultProcessRunRecordListLimit;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("Run Record list limit must be a positive integer");
    }
    return Math.min(value, maximumProcessRunRecordListLimit);
}

export type ProcessRunRecordCursor = Readonly<{
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
