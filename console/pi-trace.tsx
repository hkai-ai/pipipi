/** 展开实际加载的 Skill、每轮工具权限、调用结果及业务校验。 */
import type { PiSessionTrace } from "../src/process-runtime/pi-trace.js";
import { formatDuration } from "./formatting.jsx";

const outcomes = {
    stop: "完成回复",
    toolUse: "请求工具",
    length: "达到输出上限",
    error: "模型错误",
    aborted: "已取消",
    pending: "等待中",
    deferred: "已延后",
} as const;
export function PiTrace({ session }: { session: PiSessionTrace }) {
    return (
        <details class="technical-details">
            <summary>Pi 会话 {session.sessionId}</summary>
            <p>本次加载的 Runtime Skill</p>
            <ul>
                {session.skills.map((skill) => (
                    <li key={skill.name}>
                        {skill.name} · {skill.version ?? "版本未采集"}
                    </li>
                ))}
            </ul>
            {session.rounds.length ? (
                <ol>
                    {session.rounds.map((round) => (
                        <li key={round.round}>
                            <strong>模型第 {round.round} 轮</strong> ·{" "}
                            {round.model ?? "模型未采集"} ·{" "}
                            {round.outcome
                                ? outcomes[round.outcome]
                                : "结果未采集"}{" "}
                            ·{" "}
                            {round.durationMs === undefined
                                ? "耗时未采集"
                                : formatDuration(round.durationMs)}
                            <p>
                                {round.tools === undefined
                                    ? "工具权限未采集"
                                    : round.tools.length
                                      ? "本轮开放工具：" +
                                        round.tools.join("、")
                                      : "未开放工具"}
                            </p>
                            {round.calls.length ? (
                                <ul>
                                    {round.calls.map((call) => (
                                        <li key={call.call}>
                                            调用 {call.call} ·{" "}
                                            {call.name ?? "工具名称未采集"} ·{" "}
                                            {call.result === "returned"
                                                ? "工具返回成功"
                                                : call.result === "error"
                                                  ? "工具返回错误"
                                                  : "返回未采集"}{" "}
                                            ·{" "}
                                            {call.durationMs === undefined
                                                ? "耗时未采集"
                                                : formatDuration(
                                                      call.durationMs,
                                                  )}
                                        </li>
                                    ))}
                                </ul>
                            ) : round.tools?.length ? (
                                <p>{round.outcome ? "未调用" : "调用未采集"}</p>
                            ) : null}
                            <p>
                                {round.usage ? (
                                    <>
                                        供应商 token 用量 · 输入{" "}
                                        {round.usage.input ?? "未采集"} · 输出{" "}
                                        {round.usage.output ?? "未采集"} · 总计{" "}
                                        {round.usage.totalTokens ?? "未采集"}
                                        {round.usage.cacheRead !== undefined
                                            ? " · 读缓存 " +
                                              round.usage.cacheRead
                                            : ""}
                                        {round.usage.cacheWrite !== undefined
                                            ? " · 写缓存 " +
                                              round.usage.cacheWrite
                                            : ""}
                                        {round.usage.reasoning !== undefined
                                            ? ` · 推理 ${round.usage.reasoning}`
                                            : ""}
                                    </>
                                ) : (
                                    "供应商 token 用量未采集"
                                )}
                            </p>
                        </li>
                    ))}
                </ol>
            ) : (
                <p>模型轮次未采集</p>
            )}
            <p>
                {session.validation === "passed"
                    ? "最终业务校验通过"
                    : session.validation === "failed"
                      ? "最终业务校验失败"
                      : "最终业务校验未采集"}
            </p>
        </details>
    );
}
