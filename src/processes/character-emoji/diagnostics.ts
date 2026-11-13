/** 保留表情包阶段耗时、调用次数及失败分类，不携带业务正文。 */
import { agentDiagnostic } from "../../agent-runtime/diagnostics.js";
import { AgentExecutionFailure } from "../../agent-runtime/failure.js";
import type { ActivityDiagnostic } from "../../process-runtime/diagnostics.js";
import { traceIssueFields } from "../../process-runtime/pi-trace.js";
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

/** 只保留固定字段与规则码，动态路径不进入诊断。 */
export function planningIssues(
    issues: readonly { path: readonly PropertyKey[]; code: string }[],
) {
    return issues.slice(0, 12).map(({ path, code }) => ({
        path: path
            .map((part) =>
                typeof part === "number" || traceIssueFields.has(String(part))
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

export function planningDiagnostic(error: unknown): ActivityDiagnostic {
    if (!(error instanceof EmojiFailure)) return agentDiagnostic(error);
    switch (error.code) {
        case "invalid_json":
            return { stage: "json", code: "invalid_json" };
        case "invalid_schema":
            return { stage: "schema", code: "invalid_schema" };
        case "invalid_source":
        case "repair_changed_content":
        case "business_validation":
            return { stage: "schema", code: "invalid_contract" };
        case "refused":
            return { stage: "response", code: "model_refusal" };
        case "empty_response":
        case "incomplete_response":
            return { stage: "response", code: error.code };
        case "timeout":
        case "cancelled":
            return { stage: "request", code: error.code };
        default:
            return { stage: "request", code: "execution" };
    }
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
            (signal.aborted
                ? cancellationCode(signal)
                : error instanceof AgentExecutionFailure
                  ? error.diagnostic.code
                  : "execution"),
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
