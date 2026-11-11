/** 从净化错误码和活动证据生成排查提示，不推断未知根因或费用。 */

import {
    type ActivityDiagnostic,
    explainDiagnostic,
    sanitizeActivityDiagnostic,
} from "../src/process-runtime/diagnostics.js";
import type { ProcessRunRecord, RunTimeline } from "./api.js";

const advice: Record<string, { title: string; next: string }> = {
    PROCESS_NOT_FOUND: {
        title: "业务版本不存在",
        next: "核对请求的 Process 与精确版本，再对照当前服务目录及已部署版本。",
    },
    AGENT_FAILURE: {
        title: "Agent 执行失败",
        next: "查看失败活动和同类记录，再检查模型依赖与响应校验；此错误码本身不能确定根因。",
    },
    INVALID_INPUT: {
        title: "输入未通过校验",
        next: "对照当前版本的输入 Schema 检查字段类型与必填项。",
    },
    DEPENDENCY_FAILURE: {
        title: "外部依赖失败",
        next: "定位失败活动，核对对应依赖的可用性与请求结果；重新提交前确认原请求是否已受理。",
    },
    DEPENDENCY_FAILURE_AFTER_COMMIT: {
        title: "副作用已提交，交付失败",
        next: "先核对原请求及产物。可能已产生费用，不应直接重新生成或重放付费操作。",
    },
    PROCESS_TIMEOUT: {
        title: "执行超时",
        next: "检查活动耗时与执行预算；先确认原任务的最终状态，再决定后续操作。",
    },
    CANCELLED: {
        title: "执行已取消",
        next: "核对取消来源及已有活动，确认下游副作用状态。",
    },
};
export function explainError(code?: string) {
    return code && advice[code]
        ? advice[code]
        : {
              title: "执行失败，原因待确认",
              next: "查看活动时间线，并携带运行 ID 和错误码排查；缺少证据时不推断失败原因。",
          };
}

function isFallbackDiagnostic(
    code: string | undefined,
    diagnostic?: ActivityDiagnostic,
) {
    return (
        diagnostic?.code === "internal_failure" &&
        code !== undefined &&
        code !== "INTERNAL_ERROR"
    );
}

/** 保留业务依赖处置约束，默认内部诊断不覆盖已知公开错误分类。 */
export function explainRunFailure(
    code: string | undefined,
    diagnostic?: ActivityDiagnostic,
) {
    if (
        code === "DEPENDENCY_FAILURE" ||
        code === "DEPENDENCY_FAILURE_AFTER_COMMIT" ||
        isFallbackDiagnostic(code, diagnostic)
    )
        return explainError(code);
    return diagnostic ? explainDiagnostic(diagnostic) : explainError(code);
}

export function describeTimeline(timeline?: RunTimeline) {
    const entries = timeline?.activities ?? [];
    const latestAttempt = Math.max(
        0,
        ...entries.map((entry) => entry.attemptNumber),
    );
    const attempt = entries.filter(
        (entry) => entry.attemptNumber === latestAttempt,
    );
    const lastActivity = attempt.findLast(
        (entry) => entry.event === "process_run_activity_finished",
    );
    const failed =
        lastActivity && lastActivity.outcome !== "succeeded"
            ? lastActivity
            : undefined;
    const finished = attempt.findLast(
        (entry) => entry.event === "process_run_attempt_finished",
    );
    const terminalDiagnostic =
        finished && "diagnostic" in finished
            ? sanitizeActivityDiagnostic(finished.diagnostic)
            : undefined;
    const activityDiagnostic =
        failed && "diagnostic" in failed
            ? sanitizeActivityDiagnostic(failed.diagnostic)
            : undefined;
    const diagnostic =
        terminalDiagnostic?.code === "process_cancelled" ||
        terminalDiagnostic?.code === "process_timeout"
            ? terminalDiagnostic
            : (activityDiagnostic ?? terminalDiagnostic);
    return {
        attempt: latestAttempt,
        failedActivity:
            failed && "activity" in failed ? failed.activity : undefined,
        ...(diagnostic ? { diagnostic } : {}),
        durationMs:
            finished && "durationMs" in finished
                ? finished.durationMs
                : undefined,
    };
}

export function diagnosticSummary(
    record: ProcessRunRecord,
    timeline?: RunTimeline,
): string {
    const detail = describeTimeline(timeline);
    const failure =
        record.status === "failed"
            ? explainRunFailure(record.errorCode, detail.diagnostic)
            : undefined;
    return [
        `运行 ID: ${record.runId}`,
        `业务: ${record.process ?? "未知"}/${record.version ?? "未知"}`,
        `状态: ${record.status}`,
        `记录时间: ${record.recordedAt}`,
        `错误码: ${record.errorCode ?? "无"}`,
        `最后 Attempt: ${detail.attempt || "无记录"}`,
        ...(failure
            ? [
                  `失败活动: ${detail.failedActivity ?? "无可用证据"}`,
                  `失败原因: ${failure.title}`,
                  `下一步: ${failure.next}`,
                  ...(isFallbackDiagnostic(record.errorCode, detail.diagnostic)
                      ? ["细分原因: 未记录，仅有默认内部诊断"]
                      : detail.diagnostic
                        ? [
                              `失败阶段: ${explainDiagnostic(detail.diagnostic).stage}`,
                              `诊断码: ${detail.diagnostic.stage}/${detail.diagnostic.code}`,
                              ...(detail.diagnostic.issues ?? []).map(
                                  (issue) =>
                                      `校验: ${issue.path} (${issue.code})`,
                              ),
                          ]
                        : ["细分原因: 未记录，无法从总类判断根因"]),
              ]
            : []),
        `Attempt 耗时: ${detail.durationMs === undefined ? "无记录" : `${detail.durationMs} ms`}`,
    ].join("\n");
}
