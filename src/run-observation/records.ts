/** Run Record 归档 Interface，以及两套 Adapter 共用的游标、分页上限、净化和聚合规则 */
import { createHash } from "node:crypto";
import {
    sanitizeFailureDetail,
    stripUrlQueryString,
} from "../process-runtime/input-validation.js";
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
    version?: string;
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

/** 归档保留审批身份与图片摘要，省略成图字节，净化 CRT 来源地址并剥离签名 URL 查询参数。 */
export function redactProcessRunRecord(
    record: ProcessRunRecord,
): ProcessRunRecord {
    const failureDetail = sanitizeFailureDetail(record.failureDetail);
    let next: ProcessRunRecord =
        record.failureDetail === undefined && failureDetail === undefined
            ? record
            : {
                  ...record,
                  ...(failureDetail === undefined
                      ? { failureDetail: undefined }
                      : { failureDetail }),
              };
    if (failureDetail === undefined && "failureDetail" in next) {
        const { failureDetail: _dropped, ...rest } = next;
        next = rest;
    }

    const content = next.content;
    if (!content) return next;

    let input = content.input;
    let output = content.output;
    let changed = false;

    if (
        next.process === "template-image-render" &&
        next.version === "v1" &&
        typeof output === "object" &&
        output !== null &&
        "imageDataUrl" in output
    ) {
        const { imageDataUrl: _imageDataUrl, ...metadata } = output;
        output = metadata;
        changed = true;
    }

    if (
        next.process === "crt-interface-image" &&
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        "sourceImageUrl" in input &&
        typeof input.sourceImageUrl === "string"
    ) {
        const { sourceImageUrl, ...rest } = input as Record<string, unknown> & {
            sourceImageUrl: string;
        };
        input = {
            ...rest,
            sourceImageUrlSha256: createHash("sha256")
                .update(sourceImageUrl, "utf8")
                .digest("hex"),
        };
        changed = true;
    } else {
        const strippedInput = stripSignedUrlFields(input);
        if (strippedInput !== input) {
            input = strippedInput;
            changed = true;
        }
    }

    const strippedOutput = stripSignedUrlFields(output);
    if (strippedOutput !== output) {
        output = strippedOutput;
        changed = true;
    }

    return changed
        ? {
              ...next,
              content: {
                  input,
                  ...(output === undefined ? {} : { output }),
              },
          }
        : next;
}

const signedUrlFieldNames = new Set([
    "imageUrl",
    "sourceImageUrl",
    "referenceImage",
    "cover",
]);

function stripSignedUrlFields(value: unknown, depth = 0): unknown {
    if (depth > 4 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        let changed = false;
        const mapped = value.map((item) => {
            const next = stripSignedUrlFields(item, depth + 1);
            if (next !== item) changed = true;
            return next;
        });
        return changed ? mapped : value;
    }
    const record = value as Record<string, unknown>;
    let changed = false;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
        if (signedUrlFieldNames.has(key) && typeof item === "string") {
            const clean = stripUrlQueryString(item);
            copy[key] = clean;
            if (clean !== item) changed = true;
        } else {
            const next = stripSignedUrlFields(item, depth + 1);
            copy[key] = next;
            if (next !== item) changed = true;
        }
    }
    return changed ? copy : value;
}
