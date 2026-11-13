/** 本地开发控制台按 runId 轮询活跃请求，结束或离开后清除已展开的临时正文。 */
import { useEffect, useState } from "preact/hooks";
import type { LocalTraceEvent } from "../src/process-runtime/local-trace.js";
import { Panel } from "./formatting.jsx";
import { hrefFor } from "./routing.js";

type Run = { runId: string; process: string; version: string };
type Data = {
    runs?: Run[];
    events?: LocalTraceEvent[];
    ended?: boolean;
    error?: boolean;
};
const labels = {
    input: "模型输入",
    model: "模型回复",
    toolCall: "工具参数",
    toolResult: "工具返回",
    validation: "服务端校验",
    result: "正式业务结果",
};
export function LiveView({ runId }: { runId?: string }) {
    const [data, setData] = useState<Data>({});
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const path = runId
                    ? `live/${encodeURIComponent(runId)}`
                    : "live";
                const response = await fetch(new URL(path, document.baseURI), {
                    cache: "no-store",
                    signal: controller.signal,
                });
                if (runId && response.status === 404) {
                    if (!controller.signal.aborted) setData({ ended: true });
                    return;
                }
                if (!response.ok) throw new Error();
                const current = await response.json();
                if (!controller.signal.aborted) setData(current);
            } catch {
                if (!controller.signal.aborted) setData({ error: true });
            }
            if (!controller.signal.aborted) timer = setTimeout(poll, 350);
        };
        void poll();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [runId]);
    return (
        <Panel title="本地实时调试">
            {runId ? (
                <>
                    <a href={hrefFor({ view: "live" })}>返回活跃请求</a>
                    <h3>{runId}</h3>
                </>
            ) : (
                <p class="hint">
                    在本机通过 /execute 发起请求后，选择正在执行的运行。
                </p>
            )}
            {data.error ? <p role="alert">实时内容读取失败。</p> : null}
            {data.ended ? <p>请求已结束，实时正文已清除。</p> : null}
            {data.runs?.length === 0 ? <p>当前没有活跃请求。</p> : null}
            {data.runs?.map((run) => (
                <p key={run.runId}>
                    <a href={hrefFor({ view: "live", runId: run.runId })}>
                        {run.runId}
                    </a>{" "}
                    · {run.process}/{run.version}
                </p>
            ))}
            {data.events?.length === 0 ? <p>尚未采集到可展示的字段。</p> : null}
            {data.events?.map((event, index) => (
                <details key={index}>
                    <summary>
                        {labels[event.kind]} · {event.field}
                    </summary>
                    {event.activityId ? (
                        <small>
                            活动 {event.activityId}
                            {event.sessionId
                                ? ` · 会话 ${event.sessionId}`
                                : ""}
                            {event.round ? ` · 第 ${event.round} 轮` : ""}
                            {event.call ? ` · 调用 ${event.call}` : ""}
                        </small>
                    ) : null}
                    {event.value !== undefined ? (
                        <pre>{event.value}</pre>
                    ) : null}
                    {event.note ? <p class="hint">{event.note}</p> : null}
                </details>
            ))}
            {runId &&
            data.events &&
            !data.events.some((e) => e.kind === "result") ? (
                <p class="hint">正式业务结果将在请求完成时返回。</p>
            ) : null}
            {runId && data.ended ? (
                <a href={hrefFor({ view: "run", runId })}>
                    查看已归档的运行详情
                </a>
            ) : null}
        </Panel>
    );
}
