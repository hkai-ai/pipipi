/** 保留表情包阶段耗时、调用次数及失败分类，不携带业务正文。 */
import type { AdaptationSource } from "./materials.js";

export type EmojiFailureCode =
    | "configuration"
    | "network"
    | "timeout"
    | "cancelled"
    | "http_error"
    | "refused"
    | "invalid_response"
    | "incomplete_response"
    | "incomplete_search"
    | "empty_response"
    | "model_error"
    | "invalid_json"
    | "invalid_schema"
    | "invalid_source"
    | "business_validation"
    | "repair_changed_content"
    | "execution";

const diagnosticFields = new Set(
    "caption scene joke actors character expression action position identityMark text carrier placement propMarks composition punchlineDetail continuity page layout readingOrder frame aspectRatio panels texts kind speaker adaptation entryId entryIds original".split(
        " ",
    ),
);

/** 只保留固定字段与规则码，动态路径不进入诊断。 */
export function planningIssues(
    issues: readonly { path: readonly PropertyKey[]; code: string }[],
) {
    return issues.slice(0, 12).map(({ path, code }) => ({
        path: path
            .map((part) =>
                typeof part === "number" || diagnosticFields.has(String(part))
                    ? String(part)
                    : "*",
            )
            .join("."),
        code,
    }));
}

export class EmojiFailure extends Error {
    constructor(
        readonly stage: "search" | "planning",
        readonly code: EmojiFailureCode,
        readonly elapsedMs = 0,
        readonly httpStatus?: number,
        readonly issues?: Array<{ path: string; code: string }>,
    ) {
        super(`表情包${stage === "search" ? "搜索" : "构思"}失败：${code}`);
        this.name = "EmojiFailure";
    }
}

export function cancellationCode(signal: AbortSignal): "timeout" | "cancelled" {
    return signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled";
}

export function emojiDiagnostic(
    error: unknown,
    runId: string,
    elapsedMs: number,
    signal: AbortSignal,
) {
    const failure = error instanceof EmojiFailure ? error : undefined;
    return {
        event: "character_emoji_diagnostic" as const,
        runId,
        stage: failure?.stage ?? "planning",
        code:
            failure?.code ??
            (signal.aborted ? cancellationCode(signal) : "execution"),
        elapsedMs: failure?.elapsedMs ?? elapsedMs,
        ...(failure?.httpStatus === undefined
            ? {}
            : { httpStatus: failure.httpStatus }),
        ...(failure?.issues ? { issues: failure.issues } : {}),
    };
}
export type EmojiDiagnostic = ReturnType<typeof emojiDiagnostic>;

export type EmojiObservation =
    | Readonly<{
          stage: "search";
          outcome:
              | "usable"
              | "insufficient"
              | "unverifiable"
              | "failed"
              | "skipped";
          elapsedMs: number;
          code?: EmojiFailureCode;
          httpStatus?: number;
      }>
    | Readonly<{
          stage: "planning";
          outcome: "succeeded" | "failed";
          elapsedMs: number;
          modelCalls: number;
          repairAttempts: number;
          source?: AdaptationSource;
          libraryVersion?: string;
          localCandidates?: number;
      }>;

export type EmojiObservationRecord = EmojiObservation & {
    event: "character_emoji_observation";
    runId: string;
};
