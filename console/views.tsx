import { useEffect, useRef, useState } from "preact/hooks";
import { compareAttemptActivities } from "./activity-comparison.js";
import {
    type ConsoleProcessDescription,
    type ConsoleSkillDescription,
    type ConsoleStats,
    findRun,
    findTimeline,
    listProcesses,
    listRuns,
    listSkills,
    type ProcessRunRecord,
    type RunFilters,
    type RunTimeline,
    readStats,
    skillCoverHref,
} from "./api.js";
import {
    formatDuration,
    formatTime,
    imagesOf,
    Panel,
    StatusLabel,
    Thumbnail,
} from "./formatting.jsx";
import {
    type PendingProcessRun,
    type ProcessRunOutcome,
    type ProcessRunProgress,
    processRuns,
} from "./process-run-client.js";
import { hrefFor } from "./routing.js";

/** Every view loads asynchronously and shows why it is empty when it is. */
function useAsync<Result>(
    load: () => Promise<Result>,
    dependencies: readonly unknown[],
): Readonly<{ value?: Result; error?: string; loading: boolean }> {
    const [state, setState] = useState<{
        value?: Result;
        error?: string;
        loading: boolean;
    }>({ loading: true });

    useEffect(() => {
        let current = true;
        setState((previous) => ({ ...previous, loading: true }));
        load().then(
            (value) => current && setState({ value, loading: false }),
            (error: Error) =>
                current && setState({ error: error.message, loading: false }),
        );
        return () => {
            current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, dependencies);

    return state;
}

export function RunsView({ processes }: { processes: readonly string[] }) {
    const [filters, setFilters] = useState<RunFilters>({});
    const [draft, setDraft] = useState({
        process: "",
        status: "",
        errorCode: "",
        since: "",
        until: "",
    });
    const [pages, setPages] = useState<ProcessRunRecord[][]>([]);
    const [before, setBefore] = useState<string | undefined>(undefined);
    const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
    const [runIdQuery, setRunIdQuery] = useState("");

    const page = useAsync(
        () => listRuns({ ...filters, ...(before ? { before } : {}) }),
        [
            filters.process,
            filters.status,
            filters.errorCode,
            filters.since,
            filters.until,
            before,
        ],
    );

    useEffect(() => {
        if (!page.value) return;
        const records = [...(page.value.records ?? [])];
        setPages((previous) =>
            before === undefined ? [records] : [...previous, records],
        );
        setNextBefore(page.value.nextBefore);
    }, [page.value]);

    const records = pages.flat();
    const applyFilters = (next: RunFilters) => {
        setPages([]);
        setBefore(undefined);
        setFilters(next);
    };

    return (
        <>
            <Panel title="按 runId 检索">
                <form
                    class="toolbar"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const runId = runIdQuery.trim();
                        if (runId)
                            location.hash = hrefFor({ view: "run", runId });
                    }}
                >
                    <label class="grow">
                        runId
                        <input
                            value={runIdQuery}
                            placeholder="粘贴调用方提供的 runId"
                            onInput={(event) =>
                                setRunIdQuery(event.currentTarget.value)
                            }
                        />
                    </label>
                    <button type="submit">查看</button>
                </form>
            </Panel>

            <Panel title="运行记录">
                <form
                    class="toolbar"
                    onSubmit={(event) => {
                        event.preventDefault();
                        applyFilters({
                            ...(draft.process
                                ? { process: draft.process }
                                : {}),
                            ...(draft.status === "succeeded" ||
                            draft.status === "failed"
                                ? { status: draft.status }
                                : {}),
                            ...(draft.errorCode.trim()
                                ? {
                                      errorCode: draft.errorCode
                                          .trim()
                                          .toUpperCase(),
                                  }
                                : {}),
                            ...(draft.since
                                ? { since: localTimeAsIso(draft.since) }
                                : {}),
                            ...(draft.until
                                ? { until: localTimeAsIso(draft.until) }
                                : {}),
                        });
                    }}
                >
                    <label>
                        Process
                        <select
                            value={draft.process}
                            onChange={(event) =>
                                setDraft({
                                    ...draft,
                                    process: event.currentTarget.value,
                                })
                            }
                        >
                            <option value="">全部</option>
                            {processes.map((process) => (
                                <option key={process} value={process}>
                                    {process}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        状态
                        <select
                            value={draft.status}
                            onChange={(event) =>
                                setDraft({
                                    ...draft,
                                    status: event.currentTarget.value,
                                })
                            }
                        >
                            <option value="">全部</option>
                            <option value="succeeded">仅成功</option>
                            <option value="failed">仅失败</option>
                        </select>
                    </label>
                    <label>
                        错误码
                        <input
                            value={draft.errorCode}
                            placeholder="AGENT_FAILURE"
                            pattern="[A-Za-z][A-Za-z0-9_]{0,63}"
                            onInput={(event) =>
                                setDraft({
                                    ...draft,
                                    errorCode: event.currentTarget.value,
                                })
                            }
                        />
                    </label>
                    <label>
                        起始（含）
                        <input
                            type="datetime-local"
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
                        结束（不含）
                        <input
                            type="datetime-local"
                            value={draft.until}
                            onInput={(event) =>
                                setDraft({
                                    ...draft,
                                    until: event.currentTarget.value,
                                })
                            }
                        />
                    </label>
                    <button type="submit">应用筛选</button>
                    <button
                        type="button"
                        onClick={() => {
                            setDraft({
                                process: "",
                                status: "",
                                errorCode: "",
                                since: "",
                                until: "",
                            });
                            applyFilters({});
                        }}
                    >
                        清除
                    </button>
                </form>

                {page.error ? <p class="error">{page.error}</p> : null}
                {records.length === 0 && !page.loading ? (
                    <p class="empty">
                        窗口内没有记录。执行可能发生在启用记录之前，或已超出保留期。
                    </p>
                ) : (
                    <div class="table-scroll">
                        <table>
                            <thead>
                                <tr>
                                    <th>记录时间</th>
                                    <th>Process</th>
                                    <th>状态</th>
                                    <th>输入</th>
                                    <th>产出</th>
                                    <th>runId</th>
                                </tr>
                            </thead>
                            <tbody>
                                {records.map((record) => (
                                    <RunRow
                                        key={record.runId}
                                        record={record}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <p class="hint">
                    {page.loading ? "读取中…" : `已加载 ${records.length} 条`}
                    {nextBefore ? (
                        <>
                            {" · "}
                            <button
                                type="button"
                                onClick={() => setBefore(nextBefore)}
                            >
                                加载更早
                            </button>
                        </>
                    ) : null}
                </p>
            </Panel>
        </>
    );
}

function RunRow({ record }: { record: ProcessRunRecord }) {
    const images = imagesOf(record.content?.output);
    return (
        <tr>
            <td>{formatTime(record.recordedAt)}</td>
            <td>
                {record.process ?? "unknown"}
                <br />
                <span class="hint">{record.version ?? ""}</span>
            </td>
            <td>
                <StatusLabel record={record} />
            </td>
            <td>
                <pre class="inline">
                    {record.content
                        ? JSON.stringify(record.content.input, null, 1)
                        : "（未记录内容）"}
                </pre>
            </td>
            <td>
                {images.length > 0 ? (
                    <div class="thumb-row">
                        {images.map((image) => (
                            <Thumbnail key={image.url} image={image} />
                        ))}
                    </div>
                ) : record.content?.output !== undefined ? (
                    <pre class="inline">
                        {JSON.stringify(record.content.output, null, 1)}
                    </pre>
                ) : (
                    "—"
                )}
            </td>
            <td>
                <a
                    class="mono"
                    href={hrefFor({ view: "run", runId: record.runId })}
                >
                    {record.runId}
                </a>
            </td>
        </tr>
    );
}

export function RunView({ runId }: { runId: string }) {
    const record = useAsync(() => findRun(runId), [runId]);
    const timeline = useAsync(() => findTimeline(runId), [runId]);
    const catalog = useAsync(() => listProcesses(), []);
    const registration = catalog.value?.processes.find(
        (entry) =>
            entry.process === record.value?.process &&
            entry.version === record.value?.version,
    );

    return (
        <>
            <Panel title="运行记录">
                <p class="hint mono">{runId}</p>
                {record.error ? <p class="error">{record.error}</p> : null}
                {record.value ? <RunDetail record={record.value} /> : null}
            </Panel>
            <Panel title="活动时间线">
                {timeline.error ? (
                    <p class="error">{timeline.error}</p>
                ) : (
                    <Timeline
                        timeline={timeline.value}
                        declaredActivities={registration?.activities}
                    />
                )}
            </Panel>
        </>
    );
}

function RunDetail({ record }: { record: ProcessRunRecord }) {
    const images = imagesOf(record.content?.output);
    return (
        <>
            <table>
                <tbody>
                    <tr>
                        <th>Process</th>
                        <td>
                            {record.process ?? "unknown"} /{" "}
                            {record.version ?? "unknown"}
                        </td>
                    </tr>
                    <tr>
                        <th>状态</th>
                        <td>
                            <StatusLabel record={record} />
                        </td>
                    </tr>
                    <tr>
                        <th>记录时间</th>
                        <td>{formatTime(record.recordedAt)}</td>
                    </tr>
                </tbody>
            </table>
            {images.length > 0 ? (
                <div class="thumb-row" style="margin-top:12px">
                    {images.map((image) => (
                        <Thumbnail key={image.url} image={image} />
                    ))}
                </div>
            ) : null}
            {record.content ? (
                <>
                    <p class="hint">输入</p>
                    <pre>{JSON.stringify(record.content.input, null, 2)}</pre>
                    {record.content.output !== undefined ? (
                        <>
                            <p class="hint">输出</p>
                            <pre>
                                {JSON.stringify(record.content.output, null, 2)}
                            </pre>
                        </>
                    ) : null}
                </>
            ) : (
                <p class="hint">该记录未保存业务内容（内容策略为 omit）。</p>
            )}
        </>
    );
}

function Timeline({
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
                    {comparison.actual.join(" → ") || "尚未开始活动"}（
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

export function ProcessesView() {
    const catalog = useAsync(() => listProcesses(), []);
    return (
        <Panel title="Process 目录">
            <p class="hint">
                字段约束由服务端执行校验的 Schema
                推导，不是手写。错误语义与计费边界见业务接口文档。
            </p>
            {catalog.error ? <p class="error">{catalog.error}</p> : null}
            {catalog.value?.processes.map((entry) => (
                <ProcessEntry
                    key={`${entry.process}/${entry.version}`}
                    entry={entry}
                />
            ))}
        </Panel>
    );
}

function ProcessEntry({ entry }: { entry: ConsoleProcessDescription }) {
    return (
        <details>
            <summary>
                {entry.process} / {entry.version}
            </summary>
            <p class="hint">
                活动：{entry.activities.join(" → ")}　最大 Attempt：
                {entry.retry.maximumAttempts}
            </p>
            <SchemaTable label="输入" schema={entry.input} />
            <SchemaTable label="输出" schema={entry.output} />
        </details>
    );
}

type JsonSchema = Readonly<{
    properties?: Record<string, Record<string, unknown>>;
    required?: readonly string[];
}>;

function SchemaTable({ label, schema }: { label: string; schema: unknown }) {
    const parsed = schema as JsonSchema | undefined;
    if (!parsed?.properties) {
        return (
            <p class="hint">
                {label}：该 Schema 无法自动生成，请查阅业务接口文档。
            </p>
        );
    }
    const required = new Set(parsed.required ?? []);
    return (
        <>
            <p class="hint">{label}</p>
            <table>
                <thead>
                    <tr>
                        <th>字段</th>
                        <th>必填</th>
                        <th>约束</th>
                    </tr>
                </thead>
                <tbody>
                    {Object.entries(parsed.properties).map(
                        ([name, property]) => (
                            <tr key={name}>
                                <td class="mono">{name}</td>
                                <td>{required.has(name) ? "是" : "否"}</td>
                                <td>{describeConstraint(property)}</td>
                            </tr>
                        ),
                    )}
                </tbody>
            </table>
        </>
    );
}

function describeConstraint(property: Record<string, unknown>): string {
    const parts: string[] = [String(property.type ?? "any")];
    if (Array.isArray(property.enum)) parts.push(property.enum.join(" | "));
    if (property.minLength !== undefined || property.maxLength !== undefined) {
        parts.push(
            `${property.minLength ?? 0}–${property.maxLength ?? "∞"} 字符`,
        );
    }
    if (property.default !== undefined) {
        parts.push(`缺省 ${JSON.stringify(property.default)}`);
    }
    return parts.join("，");
}

/**
 * The installed Runtime Skills as a cover grid. The catalog is read-only by
 * design: installing, updating or removing a Skill is a reviewed code change
 * and a release, never a console action.
 */
export function SkillsView() {
    const catalog = useAsync(() => listSkills(), []);
    const [query, setQuery] = useState("");
    const needle = query.trim().toLowerCase();
    const skills = (catalog.value?.skills ?? []).filter(
        (skill) =>
            needle.length === 0 ||
            [skill.name, skill.description, ...skill.processes].some((text) =>
                text.toLowerCase().includes(needle),
            ),
    );

    return (
        <Panel title="Skill 目录">
            <p class="hint">
                随本次发布安装、并被已启用 Process 精确绑定的 Runtime
                Skill。目录只读：安装、更新或移除 Skill
                都要经过代码评审与发布，不能在控制台操作。点击卡片查看指令正文与来源记录。
            </p>
            <div class="toolbar">
                <label class="grow">
                    筛选
                    <input
                        type="search"
                        placeholder="按名称、描述或绑定 Process 筛选"
                        value={query}
                        onInput={(event) => setQuery(event.currentTarget.value)}
                    />
                </label>
                <span class="hint">
                    {catalog.value
                        ? `${skills.length} / ${catalog.value.skills.length} 个`
                        : ""}
                </span>
            </div>
            {catalog.error ? <p class="error">{catalog.error}</p> : null}
            {catalog.value && skills.length === 0 ? (
                <p class="empty">
                    {catalog.value.skills.length === 0
                        ? "当前发布没有启用任何绑定 Runtime Skill 的 Process。"
                        : "没有匹配的 Skill。"}
                </p>
            ) : null}
            <div class="skill-grid">
                {skills.map((skill) => (
                    <SkillCard
                        key={`${skill.name}@${skill.version}`}
                        skill={skill}
                    />
                ))}
            </div>
        </Panel>
    );
}

function SkillCard({ skill }: { skill: ConsoleSkillDescription }) {
    return (
        <a
            class="skill-card"
            href={hrefFor({
                view: "skill",
                name: skill.name,
                version: skill.version,
            })}
        >
            <SkillCover skill={skill} />
            <div class="skill-card-body">
                <div class="skill-card-title">
                    {skill.name}
                    <span class="skill-version">{skill.version}</span>
                </div>
                <p class="skill-card-description" title={skill.description}>
                    {skill.description || "（未提供描述）"}
                </p>
                <ProcessChips processes={skill.processes} />
            </div>
        </a>
    );
}

/**
 * A Skill without a cover still gets a stable, recognisable tile so the grid
 * scans the same whether or not every snapshot ships an image.
 */
function SkillCover({ skill }: { skill: ConsoleSkillDescription }) {
    if (skill.cover) {
        return (
            <img
                class="skill-cover"
                loading="lazy"
                src={skillCoverHref(skill)}
                alt={`${skill.name} 封面`}
            />
        );
    }
    const initials = skill.name
        .split("-")
        .filter((part) => part.length > 0)
        .slice(0, 3)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("");
    return (
        <div class="skill-cover skill-cover-missing">
            <span aria-hidden="true">{initials}</span>
            <small>未提供封面</small>
        </div>
    );
}

function ProcessChips({ processes }: { processes: readonly string[] }) {
    if (processes.length === 0) {
        return <span class="hint">未被任何已启用 Process 绑定</span>;
    }
    return (
        <div class="chips">
            {processes.map((process) => (
                <span class="chip" key={process}>
                    {process}
                </span>
            ))}
        </div>
    );
}

export function SkillView({
    name,
    version,
}: {
    name: string;
    version: string;
}) {
    const catalog = useAsync(() => listSkills(), []);
    const skill = catalog.value?.skills.find(
        (entry) => entry.name === name && entry.version === version,
    );
    const back = <a href={hrefFor({ view: "skills" })}>← 返回 Skill 目录</a>;

    if (catalog.error) {
        return (
            <Panel title={`${name} @ ${version}`} action={back}>
                <p class="error">{catalog.error}</p>
            </Panel>
        );
    }
    if (!catalog.value) {
        return (
            <Panel title={`${name} @ ${version}`} action={back}>
                <p class="hint">加载中…</p>
            </Panel>
        );
    }
    if (!skill) {
        return (
            <Panel title={`${name} @ ${version}`} action={back}>
                <p class="empty">
                    本次发布没有安装这个 Skill 版本，或它未被任何已启用 Process
                    绑定。
                </p>
            </Panel>
        );
    }

    return (
        <Panel title={`${skill.name} @ ${skill.version}`} action={back}>
            <div class="skill-hero">
                {skill.cover ? (
                    <a
                        href={skillCoverHref(skill)}
                        target="_blank"
                        rel="noreferrer"
                        title="在新标签页中打开封面"
                    >
                        <SkillCover skill={skill} />
                    </a>
                ) : (
                    <SkillCover skill={skill} />
                )}
                <div>
                    <p class="skill-description">
                        {skill.description || "（未提供描述）"}
                    </p>
                    <table>
                        <tbody>
                            <tr>
                                <th>绑定 Process</th>
                                <td>
                                    <ProcessChips processes={skill.processes} />
                                </td>
                            </tr>
                            <tr>
                                <th>SHA-256</th>
                                <td class="mono">{skill.sha256 || "—"}</td>
                            </tr>
                            <tr>
                                <th>封面文件</th>
                                <td class="mono">
                                    {skill.cover
                                        ? `${skill.cover.file}（${skill.cover.mediaType}）`
                                        : "无；在 Skill 目录放置 cover.png / cover.jpg / cover.webp 即可显示"}
                                </td>
                            </tr>
                            <tr>
                                <th>快照文件</th>
                                <td class="mono">{skill.files.join("　")}</td>
                            </tr>
                        </tbody>
                    </table>
                    <p class="hint">
                        SHA-256 只覆盖
                        SKILL.md；封面与其他随附文件不参与完整性校验。
                    </p>
                </div>
            </div>
            <details open>
                <summary>SKILL.md 指令正文（Agent 实际收到的内容）</summary>
                <pre class="skill-text">{skill.instructions}</pre>
            </details>
            {skill.source !== undefined ? (
                <details>
                    <summary>SOURCE.md 来源与审查记录</summary>
                    <pre class="skill-text">{skill.source}</pre>
                </details>
            ) : null}
        </Panel>
    );
}

export function StatsView() {
    const [hours, setHours] = useState(24);
    const [tick, setTick] = useState(0);
    const stats = useAsync(() => readStats(hours), [hours, tick]);

    useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), 15_000);
        return () => clearInterval(timer);
    }, []);

    return (
        <>
            <Panel
                title="服务压力"
                action={
                    <select
                        value={String(hours)}
                        onChange={(event) =>
                            setHours(Number(event.currentTarget.value))
                        }
                    >
                        <option value="1">最近 1 小时</option>
                        <option value="24">最近 24 小时</option>
                        <option value="168">最近 7 天</option>
                        <option value="720">最近 30 天</option>
                    </select>
                }
            >
                {stats.error ? <p class="error">{stats.error}</p> : null}
                {stats.value ? <StatsTiles stats={stats.value} /> : null}
                <p class="hint">每 15 秒自动刷新。</p>
            </Panel>

            {stats.value ? (
                <>
                    <Panel title="按 Process">
                        <ProcessCounts stats={stats.value} />
                    </Panel>
                    <Panel title="每日吞吐与失败分布">
                        <DailyCounts stats={stats.value} />
                    </Panel>
                    <Panel title="窗口内失败分布">
                        <ErrorCounts stats={stats.value} />
                    </Panel>
                    <Panel title="最近失败">
                        <RecentFailures stats={stats.value} />
                    </Panel>
                </>
            ) : null}
        </>
    );
}

function StatsTiles({ stats }: { stats: ConsoleStats }) {
    const { active, limit } = stats.concurrency;
    const total = stats.totals.succeeded + stats.totals.failed;
    return (
        <div class="tiles">
            <div class="tile">
                <div class="value">
                    {active}
                    <span class="caption"> / {limit}</span>
                </div>
                <div class="caption">当前并发执行</div>
                <div class="meter">
                    <span style={`width:${(active / limit) * 100}%`} />
                </div>
            </div>
            <div class="tile">
                <div class="value">{total}</div>
                <div class="caption">窗口内执行次数</div>
            </div>
            <div class="tile">
                <div class="value status-failed">{stats.totals.failed}</div>
                <div class="caption">失败次数</div>
            </div>
            <div class="tile">
                <div class="value">
                    {formatDuration(stats.attemptDurationMs.p50)}
                </div>
                <div class="caption">
                    Attempt 耗时 p50（{stats.attemptDurationMs.samples} 次采样）
                </div>
            </div>
            <div class="tile">
                <div class="value">
                    {formatDuration(stats.attemptDurationMs.p95)}
                </div>
                <div class="caption">
                    p95 / 最长 {formatDuration(stats.attemptDurationMs.max)}
                </div>
            </div>
        </div>
    );
}

function ProcessCounts({ stats }: { stats: ConsoleStats }) {
    if (stats.byProcess.length === 0) {
        return <p class="empty">窗口内没有执行。</p>;
    }
    return (
        <div class="table-scroll">
            <table>
                <thead>
                    <tr>
                        <th>Process</th>
                        <th class="numeric">成功</th>
                        <th class="numeric">失败</th>
                        <th class="numeric">合计</th>
                    </tr>
                </thead>
                <tbody>
                    {stats.byProcess.map((entry) => (
                        <tr key={`${entry.process}/${entry.version}`}>
                            <td>
                                {entry.process}
                                <span class="hint"> {entry.version}</span>
                            </td>
                            <td class="numeric status-succeeded">
                                {entry.succeeded}
                            </td>
                            <td class="numeric status-failed">
                                {entry.failed}
                            </td>
                            <td class="numeric">
                                {entry.succeeded + entry.failed}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function ErrorCounts({ stats }: { stats: ConsoleStats }) {
    if (stats.byErrorCode.length === 0) {
        return <p class="empty">窗口内没有失败。</p>;
    }
    return (
        <table>
            <thead>
                <tr>
                    <th>错误码</th>
                    <th class="numeric">次数</th>
                </tr>
            </thead>
            <tbody>
                {stats.byErrorCode.map((entry) => (
                    <tr key={entry.errorCode}>
                        <td
                            class={
                                entry.errorCode ===
                                "DEPENDENCY_FAILURE_AFTER_COMMIT"
                                    ? "status-billed"
                                    : undefined
                            }
                        >
                            {entry.errorCode}
                            {entry.errorCode ===
                            "DEPENDENCY_FAILURE_AFTER_COMMIT"
                                ? "（已计费未交付）"
                                : ""}
                        </td>
                        <td class="numeric">{entry.count}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function DailyCounts({ stats }: { stats: ConsoleStats }) {
    if (stats.byDay.length === 0) {
        return <p class="empty">窗口内没有执行。</p>;
    }
    return (
        <div class="table-scroll">
            <table>
                <thead>
                    <tr>
                        <th>UTC 日期</th>
                        <th class="numeric">成功</th>
                        <th class="numeric">失败</th>
                        <th>失败错误码</th>
                    </tr>
                </thead>
                <tbody>
                    {stats.byDay.map((entry) => (
                        <tr key={entry.day}>
                            <td>{entry.day}</td>
                            <td class="numeric status-succeeded">
                                {entry.succeeded}
                            </td>
                            <td class="numeric status-failed">
                                {entry.failed}
                            </td>
                            <td>
                                {entry.byErrorCode
                                    .map(
                                        ({ errorCode, count }) =>
                                            `${errorCode} × ${count}`,
                                    )
                                    .join("，") || "—"}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function RecentFailures({ stats }: { stats: ConsoleStats }) {
    if (stats.recentFailures.length === 0) {
        return <p class="empty">窗口内没有失败。</p>;
    }
    return (
        <div class="table-scroll">
            <table>
                <thead>
                    <tr>
                        <th>记录时间</th>
                        <th>Process</th>
                        <th>错误码</th>
                        <th>runId</th>
                    </tr>
                </thead>
                <tbody>
                    {stats.recentFailures.map((entry) => (
                        <tr key={entry.runId}>
                            <td>{formatTime(entry.recordedAt)}</td>
                            <td>
                                {entry.process}
                                <span class="hint"> {entry.version}</span>
                            </td>
                            <td class="status-failed">{entry.errorCode}</td>
                            <td>
                                <a
                                    class="mono"
                                    href={hrefFor({
                                        view: "run",
                                        runId: entry.runId,
                                    })}
                                >
                                    {entry.runId}
                                </a>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function localTimeAsIso(value: string): string {
    return new Date(value).toISOString();
}

type FieldDescription = Readonly<{
    name: string;
    required: boolean;
    options?: readonly string[];
    long: boolean;
}>;

export function SubmitView({
    processes,
}: {
    processes: readonly ConsoleProcessDescription[];
}) {
    const [selected, setSelected] = useState("");
    const [values, setValues] = useState<Record<string, string>>({});
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<ProcessRunProgress | undefined>(
        undefined,
    );
    const [outcome, setOutcome] = useState<ProcessRunOutcome | undefined>(
        undefined,
    );
    const [pending, setPending] = useState<PendingProcessRun | undefined>(() =>
        processRuns.pending(),
    );
    const [hasUnexpectedError, setHasUnexpectedError] = useState(false);
    const execution = useRef<AbortController | undefined>(undefined);

    useEffect(
        () => () => {
            execution.current?.abort();
        },
        [],
    );

    const entry =
        processes.find((candidate) => candidate.process === selected) ??
        processes[0];
    const fields = entry ? fieldsOf(entry) : [];

    if (!entry) return <Panel title="提交任务">读取 Process 目录中…</Panel>;

    const execute = async (intent: "continue" | "new") => {
        const controller = new AbortController();
        execution.current = controller;
        setRunning(true);
        setProgress(undefined);
        setOutcome(undefined);
        setHasUnexpectedError(false);
        const input = Object.fromEntries(
            fields
                .map((field) => [field.name, (values[field.name] ?? "").trim()])
                .filter(([, value]) => value !== ""),
        );
        try {
            const result = await processRuns.execute(
                {
                    process: entry.process,
                    version: entry.version,
                    input,
                },
                {
                    intent,
                    onProgress: setProgress,
                    signal: controller.signal,
                },
            );
            setOutcome(result);
        } catch {
            setHasUnexpectedError(true);
        } finally {
            if (execution.current === controller) {
                execution.current = undefined;
            }
            setPending(processRuns.pending());
            setRunning(false);
        }
    };

    return (
        <Panel title="提交任务">
            <p class="cost-warning">
                提交会真实执行生产流程并产生图片费用。控制台异步提交并查询结果，
                默认等待 300 秒；关闭页面或等待超时不会取消服务端 Run。
            </p>
            {pending ? (
                <PendingOperation
                    operation={pending}
                    running={running}
                    onContinue={() => execute("continue")}
                    onDismiss={() => {
                        if (!processRuns.dismiss()) return;
                        setPending(undefined);
                        setProgress(undefined);
                        setOutcome(undefined);
                        setHasUnexpectedError(false);
                    }}
                />
            ) : null}
            <form
                onSubmit={async (event) => {
                    event.preventDefault();
                    if (
                        pending?.classification === "accepted" ||
                        pending?.classification === "unavailable"
                    ) {
                        return;
                    }
                    await execute(pending ? "new" : "continue");
                }}
            >
                <label>
                    Business Process
                    <select
                        value={entry.process}
                        onChange={(event) => {
                            setSelected(event.currentTarget.value);
                            setValues({});
                        }}
                    >
                        {processes.map((candidate) => (
                            <option
                                key={candidate.process}
                                value={candidate.process}
                            >
                                {candidate.process} / {candidate.version}
                            </option>
                        ))}
                    </select>
                </label>

                {fields.map((field) => {
                    const inputId = `field-${entry.process}-${field.name}`;
                    const onChange = (value: string) =>
                        setValues({ ...values, [field.name]: value });
                    return (
                        <div key={field.name}>
                            <label for={inputId}>
                                {field.name}
                                {field.required ? " *" : "（可选）"}
                            </label>
                            {field.options ? (
                                <select
                                    id={inputId}
                                    value={values[field.name] ?? ""}
                                    onChange={(event) =>
                                        onChange(event.currentTarget.value)
                                    }
                                >
                                    {field.required ? null : (
                                        <option value="">（不填）</option>
                                    )}
                                    {field.options.map((option) => (
                                        <option key={option} value={option}>
                                            {option}
                                        </option>
                                    ))}
                                </select>
                            ) : field.long ? (
                                <textarea
                                    id={inputId}
                                    required={field.required}
                                    value={values[field.name] ?? ""}
                                    onInput={(event) =>
                                        onChange(event.currentTarget.value)
                                    }
                                />
                            ) : (
                                <input
                                    id={inputId}
                                    required={field.required}
                                    value={values[field.name] ?? ""}
                                    onInput={(event) =>
                                        onChange(event.currentTarget.value)
                                    }
                                />
                            )}
                        </div>
                    );
                })}

                <button
                    type="submit"
                    class="primary"
                    disabled={
                        running ||
                        pending?.classification === "accepted" ||
                        pending?.classification === "unavailable"
                    }
                >
                    {running
                        ? "等待结果…"
                        : pending?.classification === "accepted"
                          ? "先继续查询或移除已接受 Run"
                          : pending?.classification === "unavailable"
                            ? "浏览器恢复存储不可用"
                            : pending
                              ? "明确开始新提交（生成新幂等键）"
                              : "提交"}
                </button>
            </form>
            <SubmissionResult
                progress={progress}
                outcome={outcome}
                hasUnexpectedError={hasUnexpectedError}
            />
        </Panel>
    );
}

function PendingOperation({
    operation,
    running,
    onContinue,
    onDismiss,
}: {
    operation: PendingProcessRun;
    running: boolean;
    onContinue: () => Promise<void>;
    onDismiss: () => void;
}) {
    if (operation.classification === "unavailable") {
        return (
            <p class="error" style="margin-bottom:14px">
                浏览器恢复存储不可用。为避免响应丢失后重复创建付费
                Run，当前禁止提交。
            </p>
        );
    }
    const action =
        operation.classification === "accepted"
            ? "继续查询"
            : "重试同一操作（复用幂等键）";
    return (
        <div class="hint" style="margin-bottom:14px">
            <p>
                检测到可恢复操作 · {operation.classification} · 创建于
                {formatTime(operation.createdAt)}
                {operation.runId ? (
                    <>
                        {" "}
                        · Run <code>{operation.runId}</code>
                    </>
                ) : null}
            </p>
            {operation.classification !== "accepted" ? (
                <p>重试前请填写与原操作相同的 Process 和输入。</p>
            ) : null}
            <button type="button" disabled={running} onClick={onContinue}>
                {action}
            </button>{" "}
            <button type="button" disabled={running} onClick={onDismiss}>
                移除恢复记录
            </button>
        </div>
    );
}

function SubmissionResult({
    progress,
    outcome,
    hasUnexpectedError,
}: {
    progress?: ProcessRunProgress;
    outcome?: ProcessRunOutcome;
    hasUnexpectedError: boolean;
}) {
    if (hasUnexpectedError) {
        return <p class="error">客户端发生未预期错误，请稍后重试。</p>;
    }
    if (outcome) return <Outcome result={outcome} />;
    if (!progress) return null;
    return (
        <p class="hint" style="margin-top:14px">
            Run <code>{progress.runId}</code> 已接受，当前状态：
            <strong>{progress.status}</strong>
        </p>
    );
}

function Outcome({ result }: { result: ProcessRunOutcome }) {
    switch (result.status) {
        case "succeeded":
            return (
                <div style="margin-top:14px">
                    <p class="status-succeeded">
                        Run <code>{result.runId}</code> · succeeded
                    </p>
                    <pre>{JSON.stringify(result.output, null, 2)}</pre>
                </div>
            );
        case "failed":
            return (
                <div style="margin-top:14px">
                    <p class="status-failed">
                        Run <code>{result.runId}</code> · failed
                    </p>
                    <p class="error">
                        {result.error.code}：{result.error.message}
                    </p>
                </div>
            );
        case "result-expired":
            return (
                <p class="error" style="margin-top:14px">
                    Run <code>{result.runId}</code> 已 {result.resultStatus}，
                    结果于 {formatTime(result.resultExpiredAt)} 过期。
                </p>
            );
        case "timed-out":
            return (
                <p class="error" style="margin-top:14px">
                    Run <code>{result.runId}</code> 查询超过
                    {result.timeoutMs / 1_000} 秒；服务端仍会继续执行。
                </p>
            );
        case "cancelled":
            return (
                <p class="error" style="margin-top:14px">
                    已停止查询 Run <code>{result.runId}</code>
                    ；服务端不会收到取消请求，之后仍可继续查询。
                </p>
            );
        case "rejected":
            return (
                <p class="error" style="margin-top:14px">
                    HTTP {result.httpStatus} · {result.error.code}：
                    {result.error.message}
                </p>
            );
        case "protocol-error":
            return (
                <p class="error" style="margin-top:14px">
                    服务响应不符合 Process Run Interface：{result.code}
                </p>
            );
        case "submission-pending":
            return result.classification === "acceptance-unknown" ? (
                <p class="error" style="margin-top:14px">
                    提交响应丢失，服务端是否接受尚不确定。请重试同一操作，客户端会复用原幂等键。
                </p>
            ) : (
                <p class="error" style="margin-top:14px">
                    HTTP {result.httpStatus} · {result.error.code}
                    ：服务暂不可接受新 Run；建议 {result.retryAfterMs / 1_000}{" "}
                    秒后重试同一操作。
                </p>
            );
        case "recovery-error":
            return (
                <p class="error" style="margin-top:14px">
                    {result.code === "REQUEST_MISMATCH"
                        ? "当前输入与待恢复操作不一致；请恢复原输入，或明确开始新提交。"
                        : result.code === "ACCEPTED_OPERATION_ACTIVE"
                          ? "已有已接受的 Run；请先继续查询，或明确移除恢复记录。"
                          : result.code === "ACTIVE_OPERATION"
                            ? "另一个提交操作正在进行；本次操作未开始。"
                            : "浏览器恢复存储不可用；为避免重复创建付费 Run，本次操作未发送。"}
                </p>
            );
    }
}

/**
 * The form is generated from the same Schema the service validates against, so
 * a new Process or a changed field needs no console change.
 */
function fieldsOf(
    entry: ConsoleProcessDescription,
): readonly FieldDescription[] {
    const schema = entry.input as JsonSchema | undefined;
    if (!schema?.properties) return [];
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties).map(([name, property]) => ({
        name,
        required: required.has(name),
        ...(Array.isArray(property.enum)
            ? { options: property.enum.map(String) }
            : {}),
        long: Number(property.maxLength ?? 0) > 300,
    }));
}
