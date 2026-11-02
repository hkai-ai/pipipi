import { compareAttemptActivities } from "./activity-comparison.js";
import type { RunTimeline } from "./api.js";
import { formatDuration } from "./formatting.jsx";

export function Timeline({
    timeline,
    declaredActivities,
}: {
    timeline?: RunTimeline;
    declaredActivities?: readonly string[];
}) {
    if (!timeline) return <p class="hint">读取中…</p>;
    if (timeline.activities.length === 0) {
        return (
            <p class="empty">
                没有活动记录。执行可能发生在启用持久化之前，或已超出保留期。
            </p>
        );
    }
    return (
        <>
            {declaredActivities ? (
                <ActivityComparison
                    declared={declaredActivities}
                    timeline={timeline}
                />
            ) : null}
            <ol class="timeline">
                {timeline.activities.map((entry, index) => {
                    const outcome =
                        "outcome" in entry ? entry.outcome : undefined;
                    const failed =
                        outcome !== undefined && outcome !== "succeeded";
                    return (
                        <li
                            key={`${entry.attemptNumber}.${entry.sequence}.${index}`}
                        >
                            <span class="seq mono">
                                #{entry.attemptNumber}.{entry.sequence}
                            </span>
                            <span class={failed ? "status-failed" : undefined}>
                                {entry.event}
                                {"activity" in entry
                                    ? ` · ${entry.activity}`
                                    : ""}
                                {outcome ? ` → ${outcome}` : ""}
                                {"errorCode" in entry
                                    ? ` ${entry.errorCode}`
                                    : ""}
                            </span>
                            <span class="dur">
                                {"durationMs" in entry
                                    ? formatDuration(entry.durationMs)
                                    : ""}
                            </span>
                        </li>
                    );
                })}
            </ol>
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
    const comparisons = compareAttemptActivities(declared, timeline.activities);
    return (
        <div class="comparison">
            <p class="hint">声明顺序：{declared.join(" → ") || "无"}</p>
            {comparisons.map((comparison) => (
                <p
                    class={
                        comparison.outcome === "diverged"
                            ? "status-failed"
                            : "hint"
                    }
                    key={comparison.attemptNumber}
                >
                    Attempt {comparison.attemptNumber} 实际：
                    {comparison.actual.join(" → ") || "未记录活动开始事件"}（
                    {comparison.outcome === "matched"
                        ? "与声明一致"
                        : comparison.outcome === "ended-early"
                          ? "按声明前缀提前结束"
                          : "偏离声明顺序"}
                    ）
                </p>
            ))}
        </div>
    );
}
