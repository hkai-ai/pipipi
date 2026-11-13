/** 按执行轮次展示中文步骤、结果和耗时，并以白名单投影展示技术事件。 */

import {
    explainDiagnostic,
    sanitizeActivityDiagnostic,
} from "../src/process-runtime/diagnostics.js";
import { sanitizeProcessRunLogRecord } from "../src/process-runtime/log-record.js";
import { compareAttemptActivities } from "./activity-comparison.js";
import type { ProcessRunLogRecord, RunTimeline } from "./api.js";
import { formatDuration, formatTime } from "./formatting.jsx";
import { activityName } from "./labels.js";

import { PiTrace } from "./pi-trace.jsx";

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
    return (
        <>
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
