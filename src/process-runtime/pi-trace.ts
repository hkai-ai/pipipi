/** 定义可归档的 Pi 会话元数据，并按白名单净化历史记录。 */
import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const identifier = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const usage = z.object({
    input: count.optional(),
    output: count.optional(),
    cacheRead: count.optional(),
    cacheWrite: count.optional(),
    reasoning: count.optional(),
    totalTokens: count.optional(),
});
const call = z.object({
    call: count.positive(),
    name: identifier.optional(),
    result: z.enum(["returned", "error"]).optional(),
    durationMs: count.optional(),
});
const issueCodes = new Set(
    "invalid_type invalid_value too_small too_big unrecognized_keys custom invalid_format invalid_union invalid_key invalid_element not_multiple_of caption_setting_mismatch cast_mismatch comic_cast_mismatch legacy_layout_mismatch panel_index_mismatch text_forbidden canvas_mismatch specified_caption_mismatch".split(
        " ",
    ),
);
export const traceIssueFields: ReadonlySet<string> = new Set(
    "caption scene joke actors character expression action position identityMark text carrier placement propMarks composition punchlineDetail continuity page layout readingOrder frame aspectRatio panels texts kind speaker adaptation entryId entryIds original".split(
        " ",
    ),
);
// 已净化的业务路径在读写边界再次投影，未知字段与规则码不能夹带正文。
const issues = z
    .array(
        z.object({
            path: z.string().transform((path) =>
                path
                    .split(".")
                    .slice(0, 8)
                    .map((part) =>
                        traceIssueFields.has(part) || /^\d{1,4}$/.test(part)
                            ? part
                            : "*",
                    )
                    .join("."),
            ),
            code: z
                .string()
                .transform((code) => (issueCodes.has(code) ? code : "unknown")),
        }),
    )
    .max(12);
const decision = z.object({
    kind: z.enum([
        "search_failed",
        "search_result",
        "original_fallback",
        "validation_failed",
        "repair_started",
        "validation_passed",
        "retry_started",
        "cancelled",
    ]),
    material: z.enum(["usable", "insufficient", "unverifiable"]).optional(),
    reason: z
        .enum([
            "configuration",
            "network",
            "timeout",
            "cancelled",
            "http_error",
            "refused",
            "invalid_response",
            "incomplete_response",
            "incomplete_search",
            "empty_response",
            "model_error",
            "invalid_json",
            "invalid_schema",
            "invalid_source",
            "business_validation",
            "repair_changed_content",
            "execution",
            "connection",
            "provider_unavailable",
        ])
        .optional(),
    issues: issues.optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    call: count.positive().optional(),
});
export type PiDecision = z.infer<typeof decision>;
const round = z.object({
    round: count.positive(),
    model: identifier.optional(),
    decisions: z.array(decision).max(32).optional(),
    tools: z.array(identifier).max(64).optional(),
    calls: z.array(call).max(64),
    outcome: z
        .enum([
            "stop",
            "length",
            "toolUse",
            "error",
            "aborted",
            "deferred",
            "pending",
        ])
        .optional(),
    durationMs: count.optional(),
    usage: usage.optional(),
});
const session = z.object({
    sessionId: count.positive(),
    skills: z
        .array(
            z.object({
                name: identifier,
                version: z
                    .string()
                    .regex(/^v\d+(?:\.\d+){0,2}$/)
                    .max(32)
                    .optional(),
            }),
        )
        .max(64),
    rounds: z.array(round).max(64),
    validation: z.enum(["passed", "failed"]).optional(),
});
export type PiSessionTrace = z.infer<typeof session>;
export type PiRoundTrace = z.infer<typeof round>;
export function sanitizePiSessions(
    input: unknown,
): PiSessionTrace[] | undefined {
    if (!Array.isArray(input) || input.length > 32) return undefined;
    const parsed = z.array(session).safeParse(input);
    return parsed.success ? parsed.data : undefined;
}
