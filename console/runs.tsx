/** 运行记录筛选、分页与详情，使用可分享链接串联异常排查。 */
import { useEffect, useState } from "react";
import { explainDiagnostic } from "../src/process-runtime/diagnostics.js";
import { templateSemanticsVersion } from "../src/process-runtime/records.js";
import {
    type ConsoleProcessDescription,
    findRun,
    findTimeline,
    listOpenRuns,
    listProcesses,
    listRuns,
    type ProcessRunRecord,
    type RunFilters,
} from "./api.js";
import {
    describeTimeline,
    diagnosticSummary,
    explainRunFailure,
} from "./diagnostics.js";
import {
    formatDuration,
    formatTime,
    imagesOf,
    Panel,
    StatusLabel,
    Thumbnail,
} from "./formatting.jsx";
import { activityName, processName } from "./labels.js";
import { useAsync } from "./resource.js";
import { hrefFor } from "./routing.js";
import { Timeline } from "./timeline.jsx";
import { CollapsibleSection, SelectField } from "./ui.jsx";

function TemplateVersion({ record }: { record: ProcessRunRecord }) {
    if (
        record.status !== "succeeded" ||
        (record.process !== "template-from-image" &&
            record.process !== "template-from-source")
    )
        return null;
    const version =
        record.templateSemanticsVersion ??
        templateSemanticsVersion(record.process, record.content?.output);
    return (
        <span className="cell-meta">
            模板运行语义 {version === undefined ? "未记录" : `V${version}`}
        </span>
    );
}

function OpenRuns({ back }: { back: string }) {
    const [tick, setTick] = useState(0);
    const result = useAsync(listOpenRuns, [], tick);
    useEffect(() => {
        if (result.loading) return;
        const timer = window.setTimeout(() => setTick((n) => n + 1), 3000);
        return () => window.clearTimeout(timer);
    }, [result.loading]);
    return (
        <Panel title="最近启动的任务">
            <p className="hint">
                显示近一小时已开始且尚未记录结束的最近 100 条执行，每 3 秒刷新。
            </p>
            {result.error ? (
                <p role="alert">{result.error}</p>
            ) : result.value?.runs.length ? (
                <ul>
                    {result.value.runs.map((run) => (
                        <li key={run.runId}>
                            {formatTime(run.startedAt)} ·{" "}
                            {processName(run.process)} / {run.version} ·{" "}
                            <a
                                className="run-link"
                                href={hrefFor({
                                    view: "run",
                                    runId: run.runId,
                                    back,
                                })}
                            >
                                {run.runId}
                            </a>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="hint">
                    {result.value ? "暂无执行记录" : "读取中…"}
                </p>
            )}
        </Panel>
    );
}

export function RunsView({
    processes,
    filters = {},
}: {
    processes: readonly ConsoleProcessDescription[];
    filters?: RunFilters;
}) {
    const [draft, setDraft] = useState({
        process: filters.process ?? "",
        version: filters.version ?? "",
        status: filters.status ?? "",
        errorCode: filters.errorCode ?? "",
        since: localTime(filters.since),
        until: localTime(filters.until),
    });
    const [error, setError] = useState("");
    const [runId, setRunId] = useState("");
    const [before, setBefore] = useState<string>();
    const [tick, setTick] = useState(0);
    const [records, setRecords] = useState<readonly ProcessRunRecord[]>([]);
    const page = useAsync(
        () => listRuns({ ...filters, before }),
        [filters, before, tick],
    );
    useEffect(() => {
        if (!page.value) return;
        const incoming = page.value.records;
        setRecords((previous) =>
            before
                ? [
                      ...new Map(
                          [...previous, ...incoming].map((record) => [
                              record.runId,
                              record,
                          ]),
                      ).values(),
                  ]
                : incoming,
        );
    }, [page.value, before]);
    const listLink = hrefFor({ view: "runs", filters });
    const names = [...new Set(processes.map((entry) => entry.process))];
    if (draft.process && !names.includes(draft.process))
        names.push(draft.process);
    const versions = [
        ...new Set(
            processes
                .filter(
                    (entry) =>
                        !draft.process || entry.process === draft.process,
                )
                .map((entry) => entry.version),
        ),
    ];
    if (draft.version && !versions.includes(draft.version))
        versions.push(draft.version);
    const navigate = (next: RunFilters) => {
        location.hash = hrefFor({ view: "runs", filters: next });
    };
    return (
        <>
            <div className="page-heading">
                <div>
                    <h1>运行记录</h1>
                    <p className="hint">按运行 ID 查看执行步骤与已归档结果。</p>
                </div>
                <button
                    type="button"
                    disabled={page.loading}
                    onClick={() => {
                        setBefore(undefined);
                        setTick((value) => value + 1);
                    }}
                >
                    刷新记录
                </button>
            </div>
            <OpenRuns back={listLink} />
            <Panel title="检索与筛选">
                <form
                    className="lookup"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (runId.trim())
                            location.hash = hrefFor({
                                view: "run",
                                runId: runId.trim(),
                                back: listLink,
                            });
                    }}
                >
                    <label>
                        运行 ID
                        <input
                            value={runId}
                            placeholder="粘贴调用方提供的 runId"
                            onInput={(event) =>
                                setRunId(event.currentTarget.value)
                            }
                        />
                    </label>
                    <button type="submit">查看</button>
                </form>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        setError("");
                        const since = draft.since
                            ? new Date(draft.since).toISOString()
                            : undefined;
                        const until = draft.until
                            ? new Date(draft.until).toISOString()
                            : undefined;
                        if (since && until && since >= until) {
                            setError("开始时间必须早于结束时间。");
                            return;
                        }
                        navigate({
                            process: draft.process || undefined,
                            version: draft.version || undefined,
                            status:
                                draft.status === "failed" ||
                                draft.status === "succeeded"
                                    ? draft.status
                                    : undefined,
                            errorCode: draft.errorCode || undefined,
                            since,
                            until,
                        });
                    }}
                >
                    <div className="filter-grid">
                        <SelectField
                            label="业务"
                            value={draft.process}
                            options={[
                                { value: "", label: "全部业务" },
                                ...names.map((name) => ({
                                    value: name,
                                    label: `${processName(name)} · ${name}`,
                                })),
                            ]}
                            onChange={(next) =>
                                setDraft({
                                    ...draft,
                                    process: next,
                                    version: "",
                                })
                            }
                        />
                        <SelectField
                            label="流程版本"
                            value={draft.version}
                            options={[
                                { value: "", label: "全部版本" },
                                ...versions.map((version) => ({
                                    value: version,
                                    label: version,
                                })),
                            ]}
                            onChange={(next) =>
                                setDraft({
                                    ...draft,
                                    version: next,
                                })
                            }
                        />
                        <SelectField
                            label="状态"
                            value={draft.status}
                            options={[
                                { value: "", label: "全部状态" },
                                { value: "succeeded", label: "成功" },
                                { value: "failed", label: "失败" },
                            ]}
                            onChange={(next) =>
                                setDraft({
                                    ...draft,
                                    status: next,
                                })
                            }
                        />
                        <label>
                            错误码
                            <input
                                pattern="[A-Z][A-Z0-9_]{0,63}"
                                value={draft.errorCode}
                                placeholder="如 AGENT_FAILURE"
                                onInput={(event) =>
                                    setDraft({
                                        ...draft,
                                        errorCode: event.currentTarget.value,
                                    })
                                }
                            />
                        </label>
                        <label>
                            开始时间（含，本地时间）
                            <input
                                type="datetime-local"
                                step="0.001"
                                value={draft.since}
                                onInput={(event) =>
                                    setDraft({
                                        ...draft,
                                        since: event.currentTarget.value,
                                    })
                                }
                            />
                        </label>
                        <label>
                            结束时间（不含，本地时间）
                            <input
                                type="datetime-local"
                                step="0.001"
                                value={draft.until}
                                onInput={(event) =>
                                    setDraft({
                                        ...draft,
                                        until: event.currentTarget.value,
                                    })
                                }
                            />
                        </label>
                    </div>
                    {error ? (
                        <p role="alert" className="error">
                            {error}
                        </p>
                    ) : null}
                    <div className="actions">
                        <button type="submit" className="primary">
                            应用筛选
                        </button>
                        <a href={hrefFor({ view: "runs" })}>清除筛选</a>
                        <CopyButton
                            text={`${location.origin}${location.pathname}${listLink}`}
                            label="复制筛选链接"
                        />
                    </div>
                </form>
            </Panel>
            <Panel title="执行结果">
                {page.error ? (
                    <p role="alert" className="error">
                        {page.error}
                    </p>
                ) : null}
                {records.length ? (
                    <div className="table-scroll">
                        <table className="runs-table">
                            <thead>
                                <tr>
                                    <th>记录时间</th>
                                    <th>业务流程 / 版本</th>
                                    <th>结果</th>
                                    <th>产出</th>
                                    <th>运行 ID</th>
                                </tr>
                            </thead>
                            <tbody>
                                {records.map((record) => (
                                    <tr key={record.runId}>
                                        <td>{formatTime(record.recordedAt)}</td>
                                        <td>
                                            <strong>
                                                {processName(record.process)}
                                            </strong>
                                            <ProcessVersion
                                                process={record.process}
                                                version={record.version}
                                            />
                                            {record.callerId ? (
                                                <span className="cell-meta mono">
                                                    caller: {record.callerId}
                                                </span>
                                            ) : null}
                                            <TemplateVersion record={record} />
                                        </td>
                                        <td>
                                            <StatusLabel record={record} />
                                            {record.failureDetail?.details
                                                ?.length ? (
                                                <span className="cell-meta mono">
                                                    {
                                                        record.failureDetail
                                                            .details[0]?.path
                                                    }{" "}
                                                    (
                                                    {
                                                        record.failureDetail
                                                            .details[0]?.message
                                                    }
                                                    )
                                                </span>
                                            ) : null}
                                        </td>
                                        <td>
                                            {imagesOf(record.content?.output)
                                                .length ? (
                                                <span className="thumb-row">
                                                    {imagesOf(
                                                        record.content?.output,
                                                    ).map((image) => (
                                                        <Thumbnail
                                                            key={image.url}
                                                            image={image}
                                                        />
                                                    ))}
                                                </span>
                                            ) : record.content?.output !==
                                              undefined ? (
                                                "有结果"
                                            ) : (
                                                "—"
                                            )}
                                        </td>
                                        <td>
                                            <a
                                                className="run-link"
                                                href={hrefFor({
                                                    view: "run",
                                                    runId: record.runId,
                                                    back: listLink,
                                                })}
                                            >
                                                {record.runId}
                                            </a>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : !page.loading && !page.error ? (
                    <p className="empty">
                        没有匹配记录。可清除筛选或扩大时间范围；记录也可能已超出保留期。
                    </p>
                ) : null}
                <div className="list-footer">
                    <span aria-live="polite">
                        {page.loading
                            ? "读取中…"
                            : `已加载 ${records.length} 条`}
                    </span>
                    {page.value?.nextBefore ? (
                        <button
                            type="button"
                            disabled={page.loading}
                            onClick={() => setBefore(page.value?.nextBefore)}
                        >
                            加载更早
                        </button>
                    ) : null}
                </div>
            </Panel>
        </>
    );
}

function TemplateCompilationTimeline({
    parentRunId,
    tick,
}: {
    parentRunId: string;
    tick: number;
}) {
    const runId = `${parentRunId}:compile`;
    const timeline = useAsync(() => findTimeline(runId), [runId], tick);
    return (
        <Panel title="模板编译子运行">
            <p className="hint run-link">{runId}</p>
            {timeline.error ? (
                <p role="alert">{timeline.error}</p>
            ) : (
                <Timeline timeline={timeline.value} />
            )}
        </Panel>
    );
}

export function RunView({
    runId,
    back = "#/runs",
}: {
    runId: string;
    back?: string;
}) {
    const [tick, setTick] = useState(0);
    const record = useAsync(() => findRun(runId), [runId], tick);
    const timeline = useAsync(() => findTimeline(runId), [runId], tick);
    const catalog = useAsync(() => listProcesses(), []);
    const value = record.value;
    const recent = timeline.value?.activities.some(
        (entry) => Date.parse(entry.timestamp) >= Date.now() - 3600000,
    );
    const follow =
        !value &&
        (recent ||
            timeline.value?.queue?.status === "queued" ||
            timeline.value?.queue?.status === "running");
    useEffect(() => {
        if (!follow || record.loading || timeline.loading) return;
        const timer = window.setTimeout(() => setTick((n) => n + 1), 3000);
        return () => window.clearTimeout(timer);
    }, [follow, record.loading, timeline.loading]);
    const registration = catalog.value?.processes.find(
        (entry) =>
            entry.process === value?.process &&
            entry.version === value?.version,
    );
    const details = describeTimeline(timeline.value);
    const partialTimeline =
        !value && (timeline.value?.queue || timeline.value?.activities.length);
    const contentSourceRunId =
        value?.content?.input &&
        typeof value.content.input === "object" &&
        !Array.isArray(value.content.input) &&
        typeof (value.content.input as Record<string, unknown>).sourceRunId ===
            "string"
            ? ((value.content.input as Record<string, unknown>)
                  .sourceRunId as string)
            : undefined;
    const sourceRunId =
        value?.sourceRunId ??
        timeline.value?.queue?.sourceRunId ??
        contentSourceRunId;
    const callerId = value?.callerId ?? timeline.value?.queue?.callerId;
    const selfBack = hrefFor({ view: "run", runId, back });
    return (
        <>
            <a className="back-link" href={back}>
                返回查询页面
            </a>
            <div className="page-heading">
                <div>
                    <h1>运行详情</h1>
                    <p className="hint run-link">{runId}</p>
                </div>
                <button
                    type="button"
                    disabled={record.loading || timeline.loading}
                    onClick={() => setTick((value) => value + 1)}
                >
                    刷新详情
                </button>
            </div>
            {record.loading ? <p aria-live="polite">读取中…</p> : null}
            {record.error && !timeline.loading && !partialTimeline ? (
                <p className="notice" role="alert">
                    {record.error} 记录也可能不存在或已过保留期。
                </p>
            ) : null}
            {timeline.value?.queue && (
                <Panel title="异步任务">
                    <div className="detail-facts">
                        <div>
                            <span>队列状态</span>
                            <strong>
                                {
                                    {
                                        queued: "等待 Worker",
                                        running: "Worker 执行中",
                                        succeeded: "已成功",
                                        failed: "已失败",
                                    }[timeline.value.queue.status]
                                }
                            </strong>
                        </div>
                        <div>
                            <span>受理时间</span>
                            <strong>
                                {formatTime(timeline.value.queue.createdAt)}
                            </strong>
                        </div>
                        {timeline.value.queue.startedAt && (
                            <div>
                                <span>首次开始</span>
                                <strong>
                                    {formatTime(timeline.value.queue.startedAt)}
                                </strong>
                            </div>
                        )}
                        {timeline.value.queue.finishedAt && (
                            <div>
                                <span>结束时间</span>
                                <strong>
                                    {formatTime(
                                        timeline.value.queue.finishedAt,
                                    )}
                                </strong>
                            </div>
                        )}
                        {timeline.value.queue.callerId && (
                            <div>
                                <span>调用方</span>
                                <strong className="mono">
                                    {timeline.value.queue.callerId}
                                </strong>
                            </div>
                        )}
                        {timeline.value.queue.sourceRunId && (
                            <div>
                                <span>上游解析运行（sourceRunId）</span>
                                <a
                                    className="run-link"
                                    href={hrefFor({
                                        view: "run",
                                        runId: timeline.value.queue.sourceRunId,
                                        back: selfBack,
                                    })}
                                >
                                    {timeline.value.queue.sourceRunId}
                                </a>
                            </div>
                        )}
                    </div>
                </Panel>
            )}
            {partialTimeline && timeline.value?.activities.length ? (
                <Panel title="执行过程">
                    <Timeline timeline={timeline.value} />
                </Panel>
            ) : null}
            {timeline.value?.activities.some(
                (entry) =>
                    entry.process === "template-from-source" &&
                    "activity" in entry &&
                    entry.activity === "approved_image_compilation",
            ) && (
                <TemplateCompilationTimeline parentRunId={runId} tick={tick} />
            )}
            {value ? (
                <>
                    <Panel
                        title={processName(value.process)}
                        action={<StatusLabel record={value} />}
                    >
                        <div className="detail-facts">
                            <div>
                                <span>业务流程</span>
                                <ProcessVersion
                                    process={value.process}
                                    version={value.version}
                                />
                                <TemplateVersion record={value} />
                            </div>
                            <div>
                                <span>记录时间</span>
                                <strong>{formatTime(value.recordedAt)}</strong>
                            </div>
                            <div>
                                <span>最后一次执行耗时</span>
                                <strong>
                                    {formatDuration(details.durationMs)}
                                </strong>
                            </div>
                            {callerId ? (
                                <div>
                                    <span>调用方</span>
                                    <strong className="mono">{callerId}</strong>
                                </div>
                            ) : null}
                            {sourceRunId ? (
                                <div>
                                    <span>上游解析运行（sourceRunId）</span>
                                    <a
                                        className="run-link"
                                        href={hrefFor({
                                            view: "run",
                                            runId: sourceRunId,
                                            back: selfBack,
                                        })}
                                    >
                                        {sourceRunId}
                                    </a>
                                </div>
                            ) : null}
                        </div>
                        <div className="actions">
                            <CopyButton
                                text={value.runId}
                                label="复制运行 ID"
                            />
                            <CopyButton
                                text={diagnosticSummary(value, timeline.value)}
                                label="复制排障摘要"
                            />
                        </div>
                        <p className="hint">
                            排障摘要仅包含运行标识、状态、错误码与活动元数据，不含输入输出正文。
                        </p>
                    </Panel>
                    {value.status === "failed" ? (
                        <section className="failure-notice">
                            <h2>
                                {
                                    explainRunFailure(
                                        value.errorCode,
                                        details.diagnostic,
                                    ).title
                                }
                            </h2>
                            <p>
                                失败步骤：
                                {timeline.loading
                                    ? "正在读取"
                                    : timeline.error
                                      ? "活动记录读取失败"
                                      : details.failedActivity
                                        ? activityName(details.failedActivity)
                                        : "没有足够步骤记录"}
                            </p>
                            <p>
                                {
                                    explainRunFailure(
                                        value.errorCode,
                                        details.diagnostic,
                                    ).next
                                }
                            </p>
                            {details.diagnostic ? (
                                <p>
                                    失败阶段：
                                    {
                                        explainDiagnostic(details.diagnostic)
                                            .stage
                                    }
                                </p>
                            ) : null}
                            {value.failureDetail ? (
                                <div className="rejection-detail">
                                    <div className="detail-facts">
                                        {value.failureDetail.httpStatus ? (
                                            <div>
                                                <span>HTTP 状态 / 入口</span>
                                                <strong className="mono">
                                                    {
                                                        value.failureDetail
                                                            .httpStatus
                                                    }
                                                    {value.failureDetail
                                                        .endpoint
                                                        ? ` · POST ${value.failureDetail.endpoint}`
                                                        : ""}
                                                </strong>
                                            </div>
                                        ) : null}
                                        {value.failureDetail.idempotencyKey ? (
                                            <div>
                                                <span>Idempotency-Key</span>
                                                <strong className="mono">
                                                    {
                                                        value.failureDetail
                                                            .idempotencyKey
                                                    }
                                                </strong>
                                            </div>
                                        ) : null}
                                        {value.failureDetail.traceId ? (
                                            <div>
                                                <span>Trace ID</span>
                                                <strong className="mono">
                                                    {
                                                        value.failureDetail
                                                            .traceId
                                                    }
                                                </strong>
                                            </div>
                                        ) : null}
                                    </div>
                                    {value.failureDetail.message ? (
                                        <p className="mono">
                                            {value.failureDetail.message}
                                        </p>
                                    ) : null}
                                    {value.failureDetail.details?.length ? (
                                        <div className="table-scroll">
                                            <table>
                                                <thead>
                                                    <tr>
                                                        <th>字段路径</th>
                                                        <th>校验规则</th>
                                                        <th>失败说明</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {value.failureDetail.details.map(
                                                        (item) => (
                                                            <tr
                                                                key={`${item.path}\0${item.keyword}\0${item.message}`}
                                                            >
                                                                <td className="mono">
                                                                    {item.path}
                                                                </td>
                                                                <td className="mono">
                                                                    {
                                                                        item.keyword
                                                                    }
                                                                </td>
                                                                <td>
                                                                    {
                                                                        item.message
                                                                    }
                                                                </td>
                                                            </tr>
                                                        ),
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                            <CollapsibleSection title="技术标识">
                                <p>
                                    错误码：
                                    <code>{value.errorCode ?? "未记录"}</code>
                                </p>
                                <p>
                                    步骤标识：
                                    <code>
                                        {details.failedActivity ?? "未记录"}
                                    </code>
                                </p>
                            </CollapsibleSection>
                            <a
                                href={hrefFor({
                                    view: "runs",
                                    filters: {
                                        process: value.process,
                                        version: value.version,
                                        status: "failed",
                                        errorCode: value.errorCode,
                                    },
                                })}
                            >
                                查看同类失败记录
                            </a>
                        </section>
                    ) : null}
                    <Panel title="执行过程">
                        {timeline.error ? (
                            <p role="alert" className="error">
                                {timeline.error}
                            </p>
                        ) : (
                            <Timeline
                                timeline={timeline.value}
                                declaredActivities={registration?.activities}
                            />
                        )}
                        {catalog.error ? (
                            <p className="hint">
                                服务目录读取失败，暂不对照声明的活动顺序。
                            </p>
                        ) : null}
                    </Panel>
                    <Panel title="输入与产出">
                        {imagesOf(value.content?.output).length ? (
                            <div className="result-images">
                                {imagesOf(value.content?.output).map(
                                    (image) => (
                                        <Thumbnail
                                            key={image.url}
                                            image={image}
                                        />
                                    ),
                                )}
                            </div>
                        ) : null}
                        {value.content ? (
                            <>
                                <CollapsibleSection title="查看输入 JSON">
                                    <pre>
                                        {JSON.stringify(
                                            value.content.input,
                                            null,
                                            2,
                                        )}
                                    </pre>
                                </CollapsibleSection>
                                {value.content.output !== undefined ? (
                                    <CollapsibleSection title="查看输出 JSON">
                                        <pre>
                                            {JSON.stringify(
                                                value.content.output,
                                                null,
                                                2,
                                            )}
                                        </pre>
                                    </CollapsibleSection>
                                ) : (
                                    <p className="hint">此记录没有产出正文。</p>
                                )}
                            </>
                        ) : (
                            <p className="hint">该记录未保存业务内容。</p>
                        )}
                    </Panel>
                </>
            ) : null}
        </>
    );
}

function ProcessVersion({
    process,
    version,
}: {
    process?: string;
    version?: string;
}) {
    if (!process || !version)
        return <span className="cell-meta">流程版本未记录</span>;
    return (
        <a
            className="cell-meta process-version"
            href={hrefFor({ view: "processes", process, version })}
            title={`${process} / ${version}：业务流程版本，点击查看当前流程定义与相关技能`}
        >
            流程版本 {version} ↗
        </a>
    );
}

function CopyButton({ text, label }: { text: string; label: string }) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
    return (
        <span className="copy-action">
            <button
                type="button"
                onClick={async () => {
                    try {
                        await navigator.clipboard.writeText(text);
                        setState("copied");
                    } catch {
                        setState("failed");
                    }
                }}
            >
                {label}
            </button>
            <span className="hint" aria-live="polite">
                {state === "copied" ? "已复制" : ""}
            </span>
            {state === "failed" ? (
                <label>
                    无法访问剪贴板，请手动复制
                    <textarea readOnly value={text} />
                </label>
            ) : null}
        </span>
    );
}
function localTime(iso?: string): string {
    if (!iso || !Number.isFinite(Date.parse(iso))) return "";
    const date = new Date(iso);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, -1);
}
