/** 格式化并脱敏入参校验错误详情，独立解析请求中的流程标识与版本。 */
import type { z } from "zod";

export type InputValidationDetail = Readonly<{
    path: string;
    keyword: string;
    message: string;
}>;

export type ProcessRunFailureDetail = Readonly<{
    httpStatus?: number;
    endpoint?: "/execute" | "/process-runs";
    idempotencyKey?: string;
    traceId?: string;
    message?: string;
    details?: readonly InputValidationDetail[];
}>;

const maxValidationDetails = 20;
const maxMessageLength = 300;
const maxIdempotencyKeyLength = 200;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safePropertyNamePattern = /^[A-Za-z0-9_$-]{1,64}$/;

/** 剥离 HTTP(S) URL 的 query string 与 fragment，避免 OSS 签名参数进入响应、日志或控制台。 */
export function stripUrlQueryString(value: string): string {
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return value;
        }
        return parsed.search || parsed.hash
            ? `${parsed.origin}${parsed.pathname}`
            : value;
    } catch {
        return value;
    }
}

/** 净化面向调用方与控制台的错误文本：剥离 URL 查询参数、API Key、Bearer Token 与控制字符。 */
export function sanitizeDiagnosticText(
    value: string,
    maxLength = maxMessageLength,
): string {
    const cleaned = value
        .replace(/[\r\n\t\0]+/g, " ")
        .replace(/https?:\/\/[^\s"'<>]+/gi, (match) =>
            stripUrlQueryString(match),
        )
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/ppk_[0-9a-f]{8}(?:_[A-Za-z0-9_-]+)?/gi, "[redacted]")
        .replace(
            /\b(OSSAccessKeyId|Signature|Expires|SecurityToken|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Oss-Signature|X-Oss-Credential|X-Oss-Security-Token|access_token|api_key|apikey|token|secret)=[^&\s"']+/gi,
            "$1=[redacted]",
        )
        .replace(/\s+/g, " ")
        .trim();
    if (cleaned.length <= maxLength) return cleaned;
    return `${cleaned.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** 净化观测记录中的 Idempotency-Key，防止误填的令牌或签名参数泄露。 */
export function sanitizeIdempotencyKeyForObservation(
    value: string | undefined,
): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    return sanitizeDiagnosticText(trimmed, maxIdempotencyKeyLength);
}

/** 独立提取请求体中的 process 与 version；单个字段合法时仍保留，避免整体退化为 unknown/unknown。 */
export function extractRequestIdentity(
    rawRequest: unknown,
): Readonly<{ process?: string; version?: string }> {
    if (!isPlainRecord(rawRequest)) return {};
    const process = parseSafeIdentityField(rawRequest.process);
    const version = parseSafeIdentityField(rawRequest.version);
    return {
        ...(process === undefined ? {} : { process }),
        ...(version === undefined ? {} : { version }),
    };
}

/** 净化结构化校验错误列表。 */
export function sanitizeValidationDetails(
    details: readonly InputValidationDetail[] | undefined,
): readonly InputValidationDetail[] | undefined {
    if (!Array.isArray(details) || details.length === 0) return undefined;
    const normalized: InputValidationDetail[] = [];
    for (const item of details) {
        if (normalized.length >= maxValidationDetails) break;
        if (!item || typeof item !== "object") continue;
        const path =
            typeof item.path === "string" && item.path.length > 0
                ? sanitizePointer(item.path)
                : "/";
        const keyword =
            typeof item.keyword === "string" &&
            /^[A-Za-z0-9_-]{1,64}$/.test(item.keyword)
                ? item.keyword
                : "invalid";
        const message =
            typeof item.message === "string" && item.message.trim().length > 0
                ? sanitizeDiagnosticText(item.message, 200)
                : "is invalid";
        normalized.push(Object.freeze({ path, keyword, message }));
    }
    return normalized.length > 0 ? Object.freeze(normalized) : undefined;
}

/** 按白名单净化待归档或读取的失败审计明细。 */
export function sanitizeFailureDetail(
    value: unknown,
): ProcessRunFailureDetail | undefined {
    if (!isPlainRecord(value)) return undefined;
    const httpStatus =
        typeof value.httpStatus === "number" &&
        Number.isSafeInteger(value.httpStatus) &&
        value.httpStatus >= 400 &&
        value.httpStatus <= 599
            ? value.httpStatus
            : undefined;
    const endpoint =
        value.endpoint === "/execute" || value.endpoint === "/process-runs"
            ? value.endpoint
            : undefined;
    const idempotencyKey =
        typeof value.idempotencyKey === "string"
            ? sanitizeIdempotencyKeyForObservation(value.idempotencyKey)
            : undefined;
    const traceId =
        typeof value.traceId === "string" &&
        value.traceId.trim().length > 0 &&
        value.traceId.trim().length <= 200 &&
        !value.traceId.includes("ppk_")
            ? sanitizeDiagnosticText(value.traceId, 200)
            : undefined;
    const message =
        typeof value.message === "string" && value.message.trim().length > 0
            ? sanitizeDiagnosticText(value.message, maxMessageLength)
            : undefined;
    const details = sanitizeValidationDetails(
        Array.isArray(value.details)
            ? (value.details as InputValidationDetail[])
            : undefined,
    );
    if (
        httpStatus === undefined &&
        endpoint === undefined &&
        idempotencyKey === undefined &&
        traceId === undefined &&
        message === undefined &&
        details === undefined
    ) {
        return undefined;
    }
    return Object.freeze({
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(traceId === undefined ? {} : { traceId }),
        ...(message === undefined ? {} : { message }),
        ...(details === undefined ? {} : { details }),
    });
}

/** 将 ZodError 转换为稳定、不含用户输入原值的字段级校验详情。 */
export function formatZodValidationDetails(
    error: z.ZodError,
    rawInput?: unknown,
): readonly InputValidationDetail[] {
    const details: InputValidationDetail[] = [];
    const seen = new Set<string>();
    collectZodIssues(error.issues, rawInput, details, seen);
    if (details.length === 0) {
        return Object.freeze([
            Object.freeze({
                path: "/",
                keyword: "invalid",
                message: "input is invalid",
            }),
        ]);
    }
    return Object.freeze(details);
}

/** 生成与 details 一致、可读且脱敏的 400 错误摘要。 */
export function formatValidationErrorMessage(options: {
    process?: string;
    version?: string;
    details?: readonly InputValidationDetail[];
    fallback?: string;
}): string {
    const prefix =
        options.process && options.version
            ? `${options.process}/${options.version} input validation failed`
            : options.process
              ? `${options.process} input validation failed`
              : "Request input validation failed";
    const details = options.details ?? [];
    if (details.length === 0) {
        return sanitizeDiagnosticText(
            options.fallback ?? `${prefix}: invalid input`,
        );
    }
    const preview = details
        .slice(0, 3)
        .map((detail) => `${detail.path} ${detail.message}`)
        .join("; ");
    const extra = details.length > 3 ? ` (+${details.length - 3} more)` : "";
    return sanitizeDiagnosticText(`${prefix}: ${preview}${extra}`);
}

function collectZodIssues(
    issues: readonly z.core.$ZodIssue[],
    rawInput: unknown,
    output: InputValidationDetail[],
    seen: Set<string>,
): void {
    for (const issue of issues) {
        if (output.length >= maxValidationDetails) return;
        if (issue.code === "invalid_union") {
            handleUnionIssue(issue, rawInput, output, seen);
            continue;
        }
        if (issue.code === "unrecognized_keys") {
            const keys = Array.isArray(issue.keys) ? issue.keys : [];
            if (keys.length === 0) {
                pushDetail(
                    output,
                    seen,
                    toJsonPointer(issue.path),
                    "additionalProperties",
                    "contains unrecognized properties",
                );
                continue;
            }
            for (const key of keys) {
                if (output.length >= maxValidationDetails) return;
                if (
                    typeof key === "string" &&
                    safePropertyNamePattern.test(key)
                ) {
                    pushDetail(
                        output,
                        seen,
                        toJsonPointer([...issue.path, key]),
                        "additionalProperties",
                        "is not an allowed property",
                    );
                } else {
                    pushDetail(
                        output,
                        seen,
                        toJsonPointer(issue.path),
                        "additionalProperties",
                        "contains an unrecognized property",
                    );
                }
            }
            continue;
        }
        const detail = mapSimpleZodIssue(issue, rawInput);
        pushDetail(output, seen, detail.path, detail.keyword, detail.message);
    }
}

function handleUnionIssue(
    issue: z.core.$ZodIssueInvalidUnion,
    rawInput: unknown,
    output: InputValidationDetail[],
    seen: Set<string>,
): void {
    const branches = issue.errors;
    const target = readAtPath(rawInput, issue.path);
    if (isPlainRecord(target) && isSourceRunModeUnion(branches)) {
        const hasSourceRunId =
            "sourceRunId" in target && target.sourceRunId !== undefined;
        const hasDirectFields =
            ("template" in target && target.template !== undefined) ||
            ("condition" in target && target.condition !== undefined);
        if (hasSourceRunId && hasDirectFields) {
            pushDetail(
                output,
                seen,
                toJsonPointer([...issue.path, "sourceRunId"]),
                "oneOf",
                "must provide either sourceRunId or template+condition, not both",
            );
            return;
        }
        if (!hasSourceRunId && !hasDirectFields) {
            pushDetail(
                output,
                seen,
                toJsonPointer(issue.path),
                "oneOf",
                "must provide either sourceRunId or template and condition",
            );
            return;
        }
    }

    const bestBranch = pickBestUnionBranch(branches, target);
    if (bestBranch && bestBranch.length > 0) {
        collectZodIssues(bestBranch, rawInput, output, seen);
        return;
    }

    pushDetail(
        output,
        seen,
        toJsonPointer(issue.path),
        "oneOf",
        "must match one of the allowed input shapes",
    );
}

function isSourceRunModeUnion(
    branches: readonly (readonly z.core.$ZodIssue[])[],
): boolean {
    if (branches.length !== 2) return false;
    const mentions = (
        branch: readonly z.core.$ZodIssue[],
        field: string,
    ): boolean =>
        branch.some(
            (item) =>
                item.path.at(-1) === field ||
                (item.code === "unrecognized_keys" &&
                    item.keys.includes(field)),
        );
    const [first, second] = branches;
    if (!first || !second) return false;
    return (
        (mentions(first, "sourceRunId") &&
            (mentions(second, "template") ||
                mentions(second, "condition") ||
                mentions(first, "template") ||
                mentions(first, "condition"))) ||
        (mentions(second, "sourceRunId") &&
            (mentions(first, "template") ||
                mentions(first, "condition") ||
                mentions(second, "template") ||
                mentions(second, "condition")))
    );
}

function pickBestUnionBranch(
    branches: readonly (readonly z.core.$ZodIssue[])[],
    target: unknown,
): readonly z.core.$ZodIssue[] | undefined {
    if (branches.length === 0) return undefined;
    if (!isPlainRecord(target)) return branches[0];
    let best: readonly z.core.$ZodIssue[] | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const branch of branches) {
        let score = branch.length * 10;
        for (const item of branch) {
            if (item.code === "unrecognized_keys") {
                // Rejecting a key that the caller explicitly provided (like sourceRunId or template)
                // strongly signals that this branch is the wrong mode.
                score += item.keys.length * 50;
            } else if (item.code === "invalid_value" && item.path.length <= 1) {
                score += 60;
            } else if (
                item.code === "invalid_type" &&
                item.path.length === 1 &&
                isMissingValue(target, item.path)
            ) {
                score += 20;
            }
        }
        if (score < bestScore) {
            bestScore = score;
            best = branch;
        }
    }
    return best;
}

function mapSimpleZodIssue(
    issue: z.core.$ZodIssue,
    rawInput: unknown,
): InputValidationDetail {
    const path = toJsonPointer(issue.path);
    switch (issue.code) {
        case "invalid_type": {
            const missing =
                isMissingValue(rawInput, issue.path) ||
                issue.message.includes("received undefined");
            if (missing) {
                return { path, keyword: "required", message: "is required" };
            }
            return {
                path,
                keyword: "type",
                message: `must be ${sanitizeDiagnosticText(String(issue.expected ?? "valid type"), 40)}`,
            };
        }
        case "too_small": {
            const op = issue.inclusive === false ? ">" : ">=";
            const min = String(issue.minimum);
            if (issue.origin === "string") {
                return {
                    path,
                    keyword: "minLength",
                    message: `must be at least ${min} characters`,
                };
            }
            if (issue.origin === "array") {
                return {
                    path,
                    keyword: "minItems",
                    message: `must contain at least ${min} items`,
                };
            }
            return {
                path,
                keyword: "minimum",
                message: `must be ${op} ${min}`,
            };
        }
        case "too_big": {
            const op = issue.inclusive === false ? "<" : "<=";
            const max = String(issue.maximum);
            if (issue.origin === "string") {
                return {
                    path,
                    keyword: "maxLength",
                    message: `must be at most ${max} characters`,
                };
            }
            if (issue.origin === "array") {
                return {
                    path,
                    keyword: "maxItems",
                    message: `must contain at most ${max} items`,
                };
            }
            return {
                path,
                keyword: "maximum",
                message: `must be ${op} ${max}`,
            };
        }
        case "invalid_value": {
            const values = Array.isArray(issue.values) ? issue.values : [];
            if (values.length === 1) {
                return {
                    path,
                    keyword: "const",
                    message: `must equal ${JSON.stringify(values[0])}`,
                };
            }
            if (values.length > 1 && values.length <= 8) {
                return {
                    path,
                    keyword: "enum",
                    message: `must be one of ${values.map((v) => JSON.stringify(v)).join(", ")}`,
                };
            }
            return {
                path,
                keyword: "enum",
                message: "must be an allowed value",
            };
        }
        case "invalid_format": {
            if (issue.format === "regex") {
                return {
                    path,
                    keyword: "pattern",
                    message: "does not match required pattern",
                };
            }
            return {
                path,
                keyword: "format",
                message: `must be a valid ${sanitizeDiagnosticText(String(issue.format ?? "format"), 40)}`,
            };
        }
        case "custom":
            return {
                path,
                keyword: "custom",
                message: sanitizeDiagnosticText(issue.message, 200),
            };
        default:
            return {
                path,
                keyword: String(issue.code),
                message: sanitizeDiagnosticText(issue.message, 200),
            };
    }
}

function pushDetail(
    output: InputValidationDetail[],
    seen: Set<string>,
    path: string,
    keyword: string,
    message: string,
): void {
    if (output.length >= maxValidationDetails) return;
    const cleanPath = sanitizePointer(path);
    const cleanMessage = sanitizeDiagnosticText(message, 200);
    const dedupeKey = `${cleanPath}\0${keyword}\0${cleanMessage}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    output.push(
        Object.freeze({
            path: cleanPath,
            keyword,
            message: cleanMessage,
        }),
    );
}

function toJsonPointer(path: readonly PropertyKey[]): string {
    if (path.length === 0) return "/";
    const segments = path.map((segment) => {
        const raw = String(segment);
        const safe =
            /^\d+$/.test(raw) || safePropertyNamePattern.test(raw)
                ? raw
                : sanitizeDiagnosticText(raw, 64);
        return safe.replace(/~/g, "~0").replace(/\//g, "~1");
    });
    return `/${segments.join("/")}`;
}

function sanitizePointer(pointer: string): string {
    const clean = sanitizeDiagnosticText(pointer, 200);
    return clean.startsWith("/") ? clean : `/${clean}`;
}

function readAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
    let current: unknown = value;
    for (const segment of path) {
        if (current === null || typeof current !== "object") return undefined;
        current = Reflect.get(current, segment);
    }
    return current;
}

function isMissingValue(root: unknown, path: readonly PropertyKey[]): boolean {
    if (path.length === 0) return root === undefined;
    const parent = readAtPath(root, path.slice(0, -1));
    if (parent === null || typeof parent !== "object") return false;
    const key = path.at(-1);
    if (key === undefined) return false;
    return Reflect.get(parent, key) === undefined;
}

function parseSafeIdentityField(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (
        trimmed.length === 0 ||
        trimmed.includes("ppk_") ||
        !safeIdentifierPattern.test(trimmed)
    ) {
        return undefined;
    }
    return trimmed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
