/** 按执行轮次展示中文步骤、结果和耗时，并以白名单投影展示技术事件。 */

import {
    type ActivityDiagnostic,
    explainDiagnostic,
    sanitizeActivityDiagnostic,
} from "../src/process-runtime/diagnostics.js";
import { sanitizeProcessRunLogRecord } from "../src/process-runtime/log-record.js";
import { compareAttemptActivities } from "./activity-comparison.js";
import type { ProcessRunLogRecord, RunTimeline } from "./api.js";
import { formatDuration, formatTime } from "./formatting.jsx";
import { activityName } from "./labels.js";

import { PiTrace } from "./pi-trace.jsx";

const reviewLabels: Record<string, string> = {
    imageFidelity: "原图还原",
    layoutAndText: "版式与文字",
    printForm: "印花形态",
    inputBindings: "输入绑定",
    defaultMigration: "默认值迁移",
    sourceIsolation: "原图特征隔离",
};
const ruleLabels: Record<string, string> = {
    review_evidence: "未通过的复核项引用了此候选字段",
    expected_text_element: "默认文字必须引用文字元素",
    expected_accent_or_decoration: "默认内容必须引用点缀或装饰元素",
    expected_accent_element: "点缀来源必须引用点缀元素",
    missing_default_color: "配色角色缺少默认颜色",
    expected_color_role: "颜色必须引用已声明的配色角色",
    subject_count: "模板必须有且只有一个主体元素",
    unresolved_review: "复核报告仍列有待解决的问题",
    missing_reference: "引用的目标字段不存在",
    missing_evidence: "缺少原图观察依据",
    value_mismatch: "字段值与关联字段不一致",
    target_binding_mismatch: "输入槽与目标绑定不匹配",
    invalid_target_scope: "目标类型不适用于此绑定",
    duplicate_id: "标识或绑定目标重复",
    missing_subject: "缺少主体元素",
    missing_edge: "矩形贴片缺少收边元素",
    max_image_slots: "主体照片槽超过一个",
    source_word: "可迁移描述含原物专属词",
    abstract_style: "描述使用了受限的抽象风格词",
    transparency_word: "描述含会造成半透明的词",
    unknown_color_role: "颜色占位引用了未定义的配色角色",
    inherent_color_conflict: "配色角色与保留主体固有色冲突",
    digest_mismatch: "复核报告未绑定本次候选",
    patch_overlap: "复核补丁路径重叠",
    invalid_json: "补丁值无法解析为 JSON",
    required: "缺少必填字段",
    invalid_type: "字段缺失或类型不匹配",
    invalid_value: "字段不符合约定取值",
    unrecognized_keys: "对象含合同之外的字段",
    too_big: "超出合同上限",
    too_small: "未达到合同下限",
};
function ContractIssues({ diagnostic }: { diagnostic?: ActivityDiagnostic }) {
    if (!diagnostic?.issues?.length)
        return diagnostic?.code === "invalid_contract" ? (
            <p>这次运行未保存具体字段和规则。</p>
        ) : null;
    return (
        <>
            {diagnostic.issues.map((issue, index) => {
                const check = issue.path.split("/")[3];
                const explanation =
                    issue.code === "check_failed"
                        ? `${reviewLabels[check] ?? "独立复核检查"}未通过`
                        : ruleLabels[issue.code];
                return (
                    <p key={`${index}-${issue.path}`}>
                        {explanation && <strong>{explanation} · </strong>}
                        校验字段 <code>{issue.path}</code> · 规则{" "}
                        <code>{issue.code}</code>
                    </p>
                );
            })}
        </>
    );
}

const outcomes: Record<string, string> = {
    succeeded: "成功",
    failed: "失败",
    timed_out: "超时",
    cancelled: "已取消",
};
export function groupAttempts(entries: readonly ProcessRunLogRecord[]) {
    const numbers = [
        ...new Set(entries.map((entry) => entry.attemptNumber)),
    ].sort((a, b) => a - b);
    return numbers.map((number) => {
        const events = entries
            .filter((entry) => entry.attemptNumber === number)
            .toSorted((a, b) => a.sequence - b.sequence);
        const end = events.findLast(
            (entry) => entry.event === "process_run_attempt_finished",
        );
        return {
            number,
            events,
            outcome: end && "outcome" in end ? end.outcome : undefined,
            durationMs: end && "durationMs" in end ? end.durationMs : undefined,
        };
    });
}
export function eventTitle(entry: ProcessRunLogRecord): string {
    switch (entry.event) {
        case "process_run_attempt_started":
            return "开始执行";
        case "process_run_attempt_finished":
            return `执行结束 · ${outcomes[entry.outcome] ?? "结果未识别"}`;
        case "process_run_activity_started":
            return `开始：${activityName(entry.activity)}`;
        case "process_run_activity_finished":
            return `${activityName(entry.activity)} · ${outcomes[entry.outcome] ?? "结果未识别"}`;
    }
}
export function Timeline({
    timeline,
    declaredActivities,
}: {
    timeline?: RunTimeline;
    declaredActivities?: readonly string[];
}) {
    if (!timeline) return <p class="hint">读取中…</p>;
    if (timeline.activities.length === 0)
        return (
            <p class="empty">
                没有执行步骤记录。记录可能尚未启用或已超出保留期。
            </p>
        );
    const attempts = groupAttempts(timeline.activities);
    const lastEvent = attempts.at(-1)?.events.at(-1);
    return (
        <>
            {lastEvent?.event === "process_run_activity_started" && (
                <p role="status">
                    当前步骤：{activityName(lastEvent.activity)}
                </p>
            )}
            <p class="hint">
                按时间查看每次执行经过的步骤。缺少结束记录不代表任务仍在运行。
            </p>
            {attempts.map((attempt) => (
                <section class="attempt" key={attempt.number}>
                    <div class="attempt-heading">
                        <h3>第 {attempt.number} 次执行</h3>
                        <span
                            class={
                                attempt.outcome === "succeeded"
                                    ? "status-succeeded"
                                    : attempt.outcome
                                      ? "status-failed"
                                      : "hint"
                            }
                        >
                            {attempt.outcome
                                ? outcomes[attempt.outcome]
                                : "结束结果未记录"}
                        </span>
                        <span class="hint">
                            耗时 {formatDuration(attempt.durationMs)}
                        </span>
                    </div>
                    <ol class="execution-steps">
                        {attempt.events.map((entry, index) => {
                            const diagnostic =
                                "diagnostic" in entry
                                    ? sanitizeActivityDiagnostic(
                                          entry.diagnostic,
                                      )
                                    : undefined;
                            const failed =
                                "outcome" in entry &&
                                entry.outcome !== "succeeded";
                            return (
                                <li
                                    key={`${entry.sequence}.${index}`}
                                    class={failed ? "step-failed" : undefined}
                                >
                                    <span class="step-dot" aria-hidden="true" />
                                    <div class="step-copy">
                                        <strong>{eventTitle(entry)}</strong>
                                        {entry.event ===
                                            "process_run_activity_finished" &&
                                            entry.sessions?.map((session) => (
                                                <PiTrace
                                                    key={session.sessionId}
                                                    session={session}
                                                />
                                            ))}
                                        {entry.event ===
                                            "process_run_activity_finished" &&
                                            !entry.sessions && (
                                                <p class="hint">
                                                    会话轨迹未采集
                                                </p>
                                            )}
                                        {entry.event ===
                                            "process_run_activity_finished" &&
                                        entry.sessions?.length === 0 ? (
                                            <p class="hint">
                                                本次活动没有 Pi 会话
                                            </p>
                                        ) : null}
                                        {diagnostic ? (
                                            <p>
                                                {
                                                    explainDiagnostic(
                                                        diagnostic,
                                                    ).title
                                                }
                                                。
                                                {
                                                    explainDiagnostic(
                                                        diagnostic,
                                                    ).next
                                                }
                                            </p>
                                        ) : null}
                                        <ContractIssues
                                            diagnostic={diagnostic}
                                        />
                                        <time
                                            class="cell-meta"
                                            dateTime={entry.timestamp}
                                        >
                                            {formatTime(entry.timestamp)}
                                        </time>
                                    </div>
                                    {"durationMs" in entry ? (
                                        <span class="step-duration">
                                            {formatDuration(entry.durationMs)}
                                        </span>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ol>
                </section>
            ))}
            <details class="technical-details">
                <summary>技术详情：原始事件与步骤标识</summary>
                {declaredActivities ? (
                    <ActivityComparison
                        declared={declaredActivities}
                        timeline={timeline}
                    />
                ) : null}
                <pre>
                    {JSON.stringify(
                        timeline.activities
                            .map(sanitizeProcessRunLogRecord)
                            .filter((entry) => entry !== undefined),
                        null,
                        2,
                    )}
                </pre>
            </details>
        </>
    );
}
function ActivityComparison({
    declared,
    timeline,
}: {
    declared: readonly string[];
    timeline: RunTimeline;
}) {
    return (
        <div class="comparison">
            <p class="hint">流程声明的步骤：{declared.join(" → ") || "无"}</p>
            {compareAttemptActivities(declared, timeline.activities).map(
                (comparison) => (
                    <p class="hint" key={comparison.attemptNumber}>
                        第 {comparison.attemptNumber} 次执行：
                        {comparison.actual.join(" → ") || "未记录步骤开始事件"}
                        （
                        {comparison.outcome === "matched"
                            ? "顺序一致，不代表执行成功"
                            : comparison.outcome === "ended-early"
                              ? "仅记录到声明顺序的前半段"
                              : "与声明顺序不同"}
                        ）
                    </p>
                ),
            )}
        </div>
    );
}
