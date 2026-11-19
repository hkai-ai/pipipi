/** 保留服务目录、Runtime Skill 浏览与人工任务提交工具。 */
import { Tooltip } from "@base-ui/react/tooltip";
import { Fragment, useEffect, useRef, useState } from "react";
import {
    type ConsoleProcessDescription,
    type ConsoleSkillDescription,
    type ConsoleStats,
    listSkills,
    readStats,
    skillCoverHref,
} from "./api.js";
import { formatTime, Panel } from "./formatting.jsx";
import { activityName, processName } from "./labels.js";
import { recordsHref } from "./overview.jsx";
import {
    type PendingProcessRun,
    type ProcessRunOutcome,
    type ProcessRunProgress,
    processRuns,
} from "./process-run-client.js";
import { useAsync } from "./resource.js";
import { hrefFor } from "./routing.js";
import { CollapsibleSection, SelectField } from "./ui.jsx";

export function ProcessesView({
    processes,
    loading,
    error,
    process,
    version,
}: {
    processes: readonly ConsoleProcessDescription[];
    loading?: boolean;
    error?: string;
    process?: string;
    version?: string;
}) {
    const statsResult = useAsync(() => readStats(24), []);
    const stats = statsResult.value;
    const [query, setQuery] = useState("");
    const needle = query.trim().toLowerCase();

    const exactTarget = Boolean(process && version);
    const targetEntry = exactTarget
        ? processes.find(
              (entry) => entry.process === process && entry.version === version,
          )
        : undefined;

    const matchingEntries = processes.filter((entry) => {
        if (process && entry.process !== process) return false;
        if (version && entry.version !== version) return false;
        if (needle.length === 0) return true;
        const searchable = [
            entry.process,
            entry.version,
            `${entry.process}/${entry.version}`,
            processName(entry.process),
            ...entry.activities,
            ...entry.activities.map(activityName),
            ...(entry.skills ?? []).flatMap((skill) => [
                skill.name,
                `${skill.name}@${skill.version}`,
            ]),
        ];
        return searchable.some((text) => text.toLowerCase().includes(needle));
    });

    const allGroupsMap = new Map<string, ConsoleProcessDescription[]>();
    for (const entry of processes) {
        const list = allGroupsMap.get(entry.process);
        if (list) list.push(entry);
        else allGroupsMap.set(entry.process, [entry]);
    }

    const visibleGroups: {
        processId: string;
        versions: readonly ConsoleProcessDescription[];
    }[] = [];
    const seenProcesses = new Set<string>();
    for (const entry of matchingEntries) {
        if (seenProcesses.has(entry.process)) continue;
        seenProcesses.add(entry.process);
        visibleGroups.push({
            processId: entry.process,
            versions: allGroupsMap.get(entry.process) ?? [entry],
        });
    }

    const statsByVersion = new Map(
        (stats?.byProcess ?? []).map((item) => [
            `${item.process}/${item.version}`,
            item,
        ]),
    );

    const [selectedVersions, setSelectedVersions] = useState<
        Readonly<Record<string, string>>
    >({});
    const [openProcesses, setOpenProcesses] = useState<ReadonlySet<string>>(
        () => new Set(),
    );

    const activeVersionFor = (
        processId: string,
        versions: readonly ConsoleProcessDescription[],
    ): ConsoleProcessDescription => {
        if (process === processId && version) {
            const pinned = versions.find((v) => v.version === version);
            if (pinned) return pinned;
        }
        const chosen = selectedVersions[processId];
        if (chosen) {
            const match = versions.find((v) => v.version === chosen);
            if (
                match &&
                (needle.length === 0 ||
                    matchingEntries.some(
                        (e) =>
                            e.process === processId &&
                            e.version === match.version,
                    ))
            ) {
                return match;
            }
        }
        if (needle.length > 0) {
            const matchedInFilter = matchingEntries
                .filter((e) => e.process === processId)
                .at(-1);
            if (matchedInFilter) return matchedInFilter;
        }
        return versions[versions.length - 1] ?? versions[0];
    };

    const isExpanded = (
        processId: string,
        versions: readonly ConsoleProcessDescription[],
    ) => {
        if (process) {
            return (
                processId === process &&
                (!version || versions.some((v) => v.version === version))
            );
        }
        return openProcesses.has(processId);
    };

    const toggleRow = (processId: string) => {
        if (process) {
            setOpenProcesses(new Set());
            location.hash = hrefFor({ view: "processes" });
            return;
        }
        setOpenProcesses((prev) => {
            const next = new Set(prev);
            if (next.has(processId)) next.delete(processId);
            else next.add(processId);
            return next;
        });
    };

    const selectVersion = (processId: string, nextVersion: string) => {
        setSelectedVersions((prev) => ({
            ...prev,
            [processId]: nextVersion,
        }));
        if (process === processId && version && version !== nextVersion) {
            location.hash = hrefFor({
                view: "processes",
                process: processId,
                version: nextVersion,
            });
        }
    };

    return (
        <Panel title="业务流程">
            <p className="hint">
                查看当前服务支持的业务流程、版本、执行步骤、关联技能与近 24
                小时调用概况。多版本流程可在行内切换版本，展开行查看完整输入输出
                Schema 与执行限制。
            </p>
            <p className="hint">
                流程版本定义一次业务调用的输入、输出与执行规则；技能版本定义
                Agent 使用的指令。两者独立编号。
            </p>
            <div className="toolbar" style={{ marginTop: 12 }}>
                <label className="grow">
                    搜索流程
                    <input
                        type="search"
                        placeholder="按业务名称、流程标识、版本、步骤或绑定 Skill 搜索"
                        value={query}
                        onInput={(event) => setQuery(event.currentTarget.value)}
                    />
                </label>
                {process || version ? (
                    <a
                        className="table-action"
                        href={hrefFor({ view: "processes" })}
                    >
                        查看全部业务流程
                    </a>
                ) : null}
                <span className="hint">
                    {!loading
                        ? `共 ${visibleGroups.length} / ${allGroupsMap.size} 个业务流程（${matchingEntries.length} / ${processes.length} 个版本）`
                        : ""}
                </span>
            </div>
            {error ? <p className="error">{error}</p> : null}
            {loading ? <p className="hint">正在读取业务流程…</p> : null}
            {!loading &&
            !error &&
            (process || version) &&
            !targetEntry &&
            matchingEntries.length === 0 ? (
                <p className="notice">
                    当前服务未注册 {processName(process)} 的流程版本{" "}
                    {version ?? "（未指定）"}
                    。它可能已下线，或请求指定的版本不存在；不能用其他版本代替查看。
                </p>
            ) : null}
            {!loading &&
            !error &&
            !(process || version) &&
            visibleGroups.length === 0 &&
            processes.length > 0 ? (
                <p className="empty">没有匹配的业务流程。</p>
            ) : null}
            {visibleGroups.length > 0 ? (
                <div className="table-scroll">
                    <table className="processes-table">
                        <thead>
                            <tr>
                                <th>业务流程</th>
                                <th>版本</th>
                                <th>执行步骤</th>
                                <th>绑定 Skill</th>
                                <th className="numeric">24h 调用</th>
                                <th className="numeric">24h 成功率</th>
                                <th className="numeric">24h 失败</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleGroups.map(({ processId, versions }) => {
                                const entry = activeVersionFor(
                                    processId,
                                    versions,
                                );
                                const key = `${entry.process}/${entry.version}`;
                                const expanded = isExpanded(
                                    processId,
                                    versions,
                                );
                                const usage = statsByVersion.get(key);
                                const total = usage
                                    ? usage.succeeded + usage.failed
                                    : 0;
                                return (
                                    <Fragment key={processId}>
                                        <tr
                                            className={
                                                expanded
                                                    ? "process-row process-row-open"
                                                    : "process-row"
                                            }
                                        >
                                            <td>
                                                <button
                                                    type="button"
                                                    className="ui-collapsible-trigger process-row-trigger"
                                                    data-panel-open={
                                                        expanded
                                                            ? ""
                                                            : undefined
                                                    }
                                                    aria-expanded={expanded}
                                                    onClick={() =>
                                                        toggleRow(processId)
                                                    }
                                                >
                                                    <span
                                                        className="ui-collapsible-chevron"
                                                        aria-hidden="true"
                                                    >
                                                        ▸
                                                    </span>
                                                    <span>
                                                        <strong>
                                                            {processName(
                                                                processId,
                                                            )}
                                                        </strong>
                                                        <span className="cell-meta mono">
                                                            {processId}
                                                        </span>
                                                    </span>
                                                </button>
                                            </td>
                                            <td>
                                                <div className="version-switcher">
                                                    {versions.map(
                                                        (candidate) => {
                                                            const isActive =
                                                                candidate.version ===
                                                                entry.version;
                                                            return versions.length >
                                                                1 ? (
                                                                <button
                                                                    key={
                                                                        candidate.version
                                                                    }
                                                                    type="button"
                                                                    className={
                                                                        isActive
                                                                            ? "version-pill version-pill-active"
                                                                            : "version-pill"
                                                                    }
                                                                    aria-label={`切换到 ${processName(processId)} ${candidate.version}`}
                                                                    aria-pressed={
                                                                        isActive
                                                                    }
                                                                    onClick={() =>
                                                                        selectVersion(
                                                                            processId,
                                                                            candidate.version,
                                                                        )
                                                                    }
                                                                >
                                                                    {
                                                                        candidate.version
                                                                    }
                                                                </button>
                                                            ) : (
                                                                <span
                                                                    key={
                                                                        candidate.version
                                                                    }
                                                                    className="version-pill version-pill-single"
                                                                >
                                                                    {
                                                                        candidate.version
                                                                    }
                                                                </span>
                                                            );
                                                        },
                                                    )}
                                                </div>
                                            </td>
                                            <td>
                                                <div className="process-steps-preview">
                                                    {entry.activities.length ? (
                                                        entry.activities
                                                            .map(activityName)
                                                            .join(" → ")
                                                    ) : (
                                                        <span className="hint">
                                                            无声明步骤
                                                        </span>
                                                    )}
                                                </div>
                                                <span className="cell-meta">
                                                    {entry.activities.length} 步
                                                    {entry.retry
                                                        .maximumAttempts > 1
                                                        ? ` · 最多 ${entry.retry.maximumAttempts} 次尝试`
                                                        : ""}
                                                </span>
                                            </td>
                                            <td>
                                                {entry.skills?.length ? (
                                                    <div className="chips">
                                                        {entry.skills.map(
                                                            (skill) => (
                                                                <a
                                                                    key={`${skill.name}@${skill.version}`}
                                                                    className="chip chip-link"
                                                                    href={hrefFor(
                                                                        {
                                                                            view: "skill",
                                                                            name: skill.name,
                                                                            version:
                                                                                skill.version,
                                                                        },
                                                                    )}
                                                                >
                                                                    {skill.name}
                                                                    @
                                                                    {
                                                                        skill.version
                                                                    }
                                                                </a>
                                                            ),
                                                        )}
                                                    </div>
                                                ) : (
                                                    <span className="cell-meta">
                                                        无 Skill
                                                    </span>
                                                )}
                                            </td>
                                            <td className="numeric">
                                                {stats ? (
                                                    total > 0 ? (
                                                        <a
                                                            href={recordsHref(
                                                                stats,
                                                                {
                                                                    process:
                                                                        entry.process,
                                                                    version:
                                                                        entry.version,
                                                                },
                                                            )}
                                                        >
                                                            {total}
                                                        </a>
                                                    ) : (
                                                        0
                                                    )
                                                ) : (
                                                    "—"
                                                )}
                                            </td>
                                            <td className="numeric">
                                                {stats && total > 0 ? (
                                                    <div className="rate-cell">
                                                        <span className="rate-bar">
                                                            <span
                                                                className={`rate-bar-fill ${
                                                                    (usage?.succeeded ??
                                                                        0) /
                                                                        total >=
                                                                    0.9
                                                                        ? "rate-good"
                                                                        : (usage?.succeeded ??
                                                                                0) /
                                                                                total >=
                                                                            0.5
                                                                          ? "rate-warn"
                                                                          : "rate-bad"
                                                                }`}
                                                                style={{
                                                                    width: `${(((usage?.succeeded ?? 0) / total) * 100).toFixed(1)}%`,
                                                                }}
                                                            />
                                                        </span>
                                                        <span>
                                                            {(
                                                                ((usage?.succeeded ??
                                                                    0) /
                                                                    total) *
                                                                100
                                                            ).toFixed(1)}
                                                            %
                                                        </span>
                                                    </div>
                                                ) : (
                                                    "—"
                                                )}
                                            </td>
                                            <td className="numeric">
                                                {stats ? (
                                                    (usage?.failed ?? 0) > 0 ? (
                                                        <a
                                                            className="status-bad-text"
                                                            href={recordsHref(
                                                                stats,
                                                                {
                                                                    process:
                                                                        entry.process,
                                                                    version:
                                                                        entry.version,
                                                                    status: "failed",
                                                                },
                                                            )}
                                                        >
                                                            {usage?.failed}
                                                        </a>
                                                    ) : (
                                                        0
                                                    )
                                                ) : (
                                                    "—"
                                                )}
                                            </td>
                                            <td>
                                                <div className="process-actions">
                                                    <ContractTooltipButton
                                                        entry={entry}
                                                        expanded={expanded}
                                                        onToggle={() =>
                                                            toggleRow(processId)
                                                        }
                                                    />
                                                    <a
                                                        className="table-action"
                                                        href={
                                                            stats
                                                                ? recordsHref(
                                                                      stats,
                                                                      {
                                                                          process:
                                                                              entry.process,
                                                                          version:
                                                                              entry.version,
                                                                      },
                                                                  )
                                                                : hrefFor({
                                                                      view: "runs",
                                                                      filters: {
                                                                          process:
                                                                              entry.process,
                                                                          version:
                                                                              entry.version,
                                                                      },
                                                                  })
                                                        }
                                                    >
                                                        记录
                                                    </a>
                                                    <a
                                                        className="table-action"
                                                        href={hrefFor({
                                                            view: "submit",
                                                            process:
                                                                entry.process,
                                                            version:
                                                                entry.version,
                                                        })}
                                                    >
                                                        调试
                                                    </a>
                                                </div>
                                            </td>
                                        </tr>
                                        {expanded ? (
                                            <tr className="process-detail-row">
                                                <td colSpan={8}>
                                                    <ProcessDetail
                                                        entry={entry}
                                                        versions={versions}
                                                        onSelectVersion={(
                                                            nextVersion,
                                                        ) =>
                                                            selectVersion(
                                                                processId,
                                                                nextVersion,
                                                            )
                                                        }
                                                        stats={stats}
                                                    />
                                                </td>
                                            </tr>
                                        ) : null}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            ) : null}
        </Panel>
    );
}

function ProcessDetail({
    entry,
    versions,
    onSelectVersion,
    stats,
}: {
    entry: ConsoleProcessDescription;
    versions: readonly ConsoleProcessDescription[];
    onSelectVersion: (version: string) => void;
    stats?: ConsoleStats;
}) {
    return (
        <div className="ui-collapsible process-detail-panel" data-open="">
            <div className="process-detail-header">
                <div>
                    <div className="process-detail-title-row">
                        <strong>
                            {processName(entry.process)} · 流程版本{" "}
                            {entry.version}
                        </strong>
                        {versions.length > 1 ? (
                            <div className="version-switcher">
                                {versions.map((candidate) => (
                                    <button
                                        key={candidate.version}
                                        type="button"
                                        className={
                                            candidate.version === entry.version
                                                ? "version-pill version-pill-active"
                                                : "version-pill"
                                        }
                                        aria-pressed={
                                            candidate.version === entry.version
                                        }
                                        onClick={() =>
                                            onSelectVersion(candidate.version)
                                        }
                                    >
                                        {candidate.version}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </div>
                    <p className="hint">
                        流程标识：<code>{entry.process}</code> · 步骤：
                        {entry.activities.length
                            ? entry.activities
                                  .map((act) => `${activityName(act)} (${act})`)
                                  .join(" → ")
                            : "无"}
                        {" · "}最多执行次数：{entry.retry.maximumAttempts}
                        {entry.retry.retryableErrorCodes.length
                            ? `（可重试：${entry.retry.retryableErrorCodes.join("、")}）`
                            : ""}
                    </p>
                </div>
                <div className="actions">
                    <a
                        className="table-action"
                        href={
                            stats
                                ? recordsHref(stats, {
                                      process: entry.process,
                                      version: entry.version,
                                  })
                                : hrefFor({
                                      view: "runs",
                                      filters: {
                                          process: entry.process,
                                          version: entry.version,
                                      },
                                  })
                        }
                    >
                        查看运行记录
                    </a>
                    <a
                        className="table-action"
                        href={
                            stats
                                ? recordsHref(stats, {
                                      process: entry.process,
                                      version: entry.version,
                                      status: "failed",
                                  })
                                : hrefFor({
                                      view: "runs",
                                      filters: {
                                          process: entry.process,
                                          version: entry.version,
                                          status: "failed",
                                      },
                                  })
                        }
                    >
                        排查失败记录
                    </a>
                    <a
                        className="table-action"
                        href={hrefFor({
                            view: "submit",
                            process: entry.process,
                            version: entry.version,
                        })}
                    >
                        去手动调试
                    </a>
                </div>
            </div>
            <div className="process-detail-skills">
                <h3>当前声明的 Runtime Skill</h3>
                {entry.skills?.length ? (
                    <ul>
                        {entry.skills.map(({ name, version }) => (
                            <li key={`${name}@${version}`}>
                                <a
                                    href={hrefFor({
                                        view: "skill",
                                        name,
                                        version,
                                    })}
                                >
                                    {name} · {version}
                                </a>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="hint">此版本未绑定 Runtime Skill。</p>
                )}
            </div>
            <div className="process-schema-grid">
                <div>
                    <SchemaTable label="输入" schema={entry.input} />
                </div>
                <div>
                    <SchemaTable label="输出" schema={entry.output} />
                </div>
            </div>
        </div>
    );
}

type JsonSchema = Readonly<{
    type?: string | readonly string[];
    properties?: Record<string, Record<string, unknown>>;
    required?: readonly string[];
    oneOf?: readonly Record<string, unknown>[];
    anyOf?: readonly Record<string, unknown>[];
    items?: Record<string, unknown>;
    enum?: readonly unknown[];
    const?: unknown;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    minItems?: number;
    maxItems?: number;
    pattern?: string;
    format?: string;
    default?: unknown;
    $ref?: string;
    $defs?: Record<string, Record<string, unknown>>;
    additionalProperties?: boolean | Record<string, unknown>;
    propertyNames?: Record<string, unknown>;
    not?: Record<string, unknown>;
}>;

type FlattenedField = Readonly<{
    path: string;
    required: boolean;
    constraint: string;
}>;

type SchemaFieldSummary = Readonly<{
    name: string;
    required: boolean;
}>;

function extractSchemaFieldSummary(schema: unknown): {
    branchCount: number;
    fields: readonly SchemaFieldSummary[];
} {
    const parsed = schema as JsonSchema | undefined;
    if (!parsed) return { branchCount: 0, fields: [] };
    const branches = (parsed.oneOf ?? parsed.anyOf) as
        | readonly JsonSchema[]
        | undefined;
    if (Array.isArray(branches) && branches.length > 0) {
        const fieldMap = new Map<string, boolean>();
        let validBranches = 0;
        const requiredCounts = new Map<string, number>();
        for (const branch of branches) {
            if (!branch.properties) continue;
            validBranches += 1;
            const req = new Set(branch.required ?? []);
            for (const [key, prop] of Object.entries(branch.properties)) {
                const p = prop as JsonSchema;
                if (p.not !== undefined && Object.keys(p.not).length === 0) {
                    continue;
                }
                if (!fieldMap.has(key)) fieldMap.set(key, false);
                if (req.has(key)) {
                    requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
                }
            }
        }
        const fields: SchemaFieldSummary[] = [];
        for (const key of fieldMap.keys()) {
            fields.push({
                name: key,
                required:
                    validBranches > 0 &&
                    (requiredCounts.get(key) ?? 0) === validBranches,
            });
        }
        fields.sort((a, b) => Number(b.required) - Number(a.required));
        return { branchCount: branches.length, fields };
    }
    if (parsed.properties) {
        const req = new Set(parsed.required ?? []);
        const fields = Object.entries(parsed.properties)
            .filter(([, prop]) => {
                const p = prop as JsonSchema;
                return !(
                    p.not !== undefined && Object.keys(p.not).length === 0
                );
            })
            .map(([name]) => ({
                name,
                required: req.has(name),
            }))
            .sort((a, b) => Number(b.required) - Number(a.required));
        return { branchCount: 0, fields };
    }
    return { branchCount: 0, fields: [] };
}

function ContractTooltipButton({
    entry,
    expanded,
    onToggle,
}: {
    entry: ConsoleProcessDescription;
    expanded: boolean;
    onToggle: () => void;
}) {
    return (
        <Tooltip.Root>
            <Tooltip.Trigger
                type="button"
                delay={120}
                closeDelay={80}
                className="link-btn"
                onClick={onToggle}
            >
                {expanded ? "收起" : "契约"}
            </Tooltip.Trigger>
            <Tooltip.Portal>
                <Tooltip.Positioner
                    className="error-tooltip-positioner"
                    side="top"
                    align="end"
                    sideOffset={8}
                    collisionPadding={12}
                >
                    <Tooltip.Popup className="contract-tooltip">
                        <div className="contract-tooltip-head">
                            <strong>{processName(entry.process)}</strong>
                            <span className="mono">
                                {entry.version} 契约摘要
                            </span>
                        </div>
                        <div className="contract-summary">
                            <SchemaPreviewLine
                                direction="入"
                                schema={entry.input}
                            />
                            <SchemaPreviewLine
                                direction="出"
                                schema={entry.output}
                            />
                        </div>
                        <span className="contract-tooltip-foot">
                            {expanded
                                ? "点击收起完整契约表"
                                : "点击展开完整输入输出 Schema 约束表"}
                        </span>
                    </Tooltip.Popup>
                </Tooltip.Positioner>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
}

function SchemaPreviewLine({
    direction,
    schema,
}: {
    direction: "入" | "出";
    schema: unknown;
}) {
    const { branchCount, fields } = extractSchemaFieldSummary(schema);
    return (
        <div className="contract-line">
            <span
                className={
                    direction === "入"
                        ? "contract-badge contract-badge-in"
                        : "contract-badge contract-badge-out"
                }
            >
                {direction}
            </span>
            {branchCount > 1 ? (
                <span className="contract-branch-tag">{branchCount}模式</span>
            ) : null}
            {fields.length > 0 ? (
                <span className="contract-fields mono">
                    {"{ "}
                    {fields.map((field, index) => (
                        <Fragment key={field.name}>
                            {index > 0 ? ", " : ""}
                            <span
                                className={
                                    field.required
                                        ? "contract-field-req"
                                        : "contract-field-opt"
                                }
                            >
                                {field.name}
                                {field.required ? "" : "?"}
                            </span>
                        </Fragment>
                    ))}
                    {" }"}
                </span>
            ) : (
                <span className="cell-meta">未定义</span>
            )}
        </div>
    );
}

function SchemaTable({ label, schema }: { label: string; schema: unknown }) {
    const parsed = schema as JsonSchema | undefined;
    if (!parsed) {
        return (
            <p className="hint">
                {label}：该 Schema 无法自动生成，请查阅业务接口文档。
            </p>
        );
    }
    const defs = parsed.$defs ?? {};
    const branches = (parsed.oneOf ?? parsed.anyOf) as
        | readonly JsonSchema[]
        | undefined;
    if (
        Array.isArray(branches) &&
        branches.length > 0 &&
        branches.every((b) => b.properties || b.oneOf || b.anyOf)
    ) {
        return (
            <div className="schema-block">
                <h3>
                    {label}（{branches.length} 种分支模式）
                </h3>
                {branches.map((branch, index) => {
                    const branchTitle = describeBranchTitle(branch, index);
                    const rows = flattenSchemaFields(branch, defs);
                    return (
                        <div key={branchTitle} className="schema-branch">
                            <p className="hint schema-branch-title">
                                <strong>{branchTitle}</strong>
                            </p>
                            <FieldRowsTable rows={rows} />
                        </div>
                    );
                })}
            </div>
        );
    }
    const rows = flattenSchemaFields(parsed, defs);
    if (rows.length === 0) {
        return (
            <p className="hint">
                {label}：该 Schema 无法自动生成，请查阅业务接口文档。
            </p>
        );
    }
    return (
        <div className="schema-block">
            <h3>{label}</h3>
            <FieldRowsTable rows={rows} />
        </div>
    );
}

function FieldRowsTable({ rows }: { rows: readonly FlattenedField[] }) {
    return (
        <table>
            <thead>
                <tr>
                    <th>字段</th>
                    <th>必填</th>
                    <th>约束</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => (
                    <tr key={row.path}>
                        <td className="mono">{row.path}</td>
                        <td>{row.required ? "是" : "否"}</td>
                        <td>{row.constraint}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function describeBranchTitle(branch: JsonSchema, index: number): string {
    const props = branch.properties ?? {};
    for (const [key, prop] of Object.entries(props)) {
        if ((prop as JsonSchema).const !== undefined) {
            return `模式 ${index + 1}：${key} = ${JSON.stringify((prop as JsonSchema).const)}`;
        }
    }
    const required = branch.required ?? [];
    if (required.length > 0) {
        return `模式 ${index + 1}（必填：${required.join(", ")}）`;
    }
    return `模式 ${index + 1}`;
}

function flattenSchemaFields(
    schema: JsonSchema,
    defs: Record<string, Record<string, unknown>>,
    prefix = "",
    depth = 0,
): FlattenedField[] {
    if (depth > 3) return [];
    const rows: FlattenedField[] = [];
    const properties = schema.properties;
    if (!properties) return rows;
    const requiredSet = new Set(schema.required ?? []);
    for (const [name, rawProp] of Object.entries(properties)) {
        const prop = resolveRef(rawProp as JsonSchema, defs);
        if (prop.not !== undefined && Object.keys(prop.not).length === 0) {
            continue;
        }
        const path = prefix ? `${prefix}.${name}` : name;
        const isRequired = requiredSet.has(name);
        rows.push({
            path,
            required: isRequired,
            constraint: describeConstraint(prop, defs),
        });
        if (prop.properties && depth < 2) {
            rows.push(...flattenSchemaFields(prop, defs, path, depth + 1));
        } else if (prop.items && depth < 2) {
            const itemSchema = resolveRef(prop.items as JsonSchema, defs);
            if (itemSchema.properties) {
                rows.push(
                    ...flattenSchemaFields(
                        itemSchema,
                        defs,
                        `${path}[]`,
                        depth + 1,
                    ),
                );
            }
        }
    }
    return rows;
}

function resolveRef(
    prop: JsonSchema,
    defs: Record<string, Record<string, unknown>>,
): JsonSchema {
    if (typeof prop.$ref === "string" && prop.$ref.startsWith("#/$defs/")) {
        const defName = prop.$ref.slice("#/$defs/".length);
        const target = defs[defName];
        if (target) return target as JsonSchema;
    }
    return prop;
}

function describeConstraint(
    property: Record<string, unknown>,
    defs: Record<string, Record<string, unknown>> = {},
): string {
    const resolved = resolveRef(property as JsonSchema, defs);
    if (resolved.const !== undefined) {
        return `固定值 ${JSON.stringify(resolved.const)}`;
    }
    const union = (resolved.oneOf ?? resolved.anyOf) as
        | readonly JsonSchema[]
        | undefined;
    if (Array.isArray(union) && union.length > 0) {
        const primitiveTypes = union
            .map((item) => item.type)
            .filter((t): t is string => typeof t === "string");
        if (primitiveTypes.length >= 4 && union.some((item) => item.$ref)) {
            return "JSON 任意值";
        }
        const branchSummaries = union.map((branch, idx) => {
            if (branch.const !== undefined) return JSON.stringify(branch.const);
            if (branch.properties) {
                const constEntry = Object.entries(branch.properties).find(
                    ([, v]) => (v as JsonSchema).const !== undefined,
                );
                const keys = Object.keys(branch.properties).join(", ");
                return constEntry
                    ? `{ ${constEntry[0]}: ${JSON.stringify((constEntry[1] as JsonSchema).const)}, ... (${keys}) }`
                    : `{ ${keys} }`;
            }
            return String(branch.type ?? `分支${idx + 1}`);
        });
        return `联合类型：${branchSummaries.join(" | ")}`;
    }
    const parts: string[] = [];
    if (resolved.type === "array") {
        const itemSchema = resolved.items
            ? resolveRef(resolved.items as JsonSchema, defs)
            : undefined;
        const itemType = itemSchema?.type ? String(itemSchema.type) : "any";
        parts.push(`array<${itemType}>`);
        if (
            resolved.minItems !== undefined ||
            resolved.maxItems !== undefined
        ) {
            parts.push(
                `${resolved.minItems ?? 0}–${resolved.maxItems ?? "∞"} 项`,
            );
        }
        if (itemSchema && Array.isArray(itemSchema.enum)) {
            parts.push(`项枚举：${itemSchema.enum.join(" | ")}`);
        }
    } else if (
        resolved.type === "object" &&
        !resolved.properties &&
        typeof resolved.additionalProperties === "object"
    ) {
        const valType =
            (resolved.additionalProperties as JsonSchema).type ?? "any";
        parts.push(`record<string, ${String(valType)}>`);
    } else {
        parts.push(String(resolved.type ?? "any"));
    }
    if (Array.isArray(resolved.enum)) parts.push(resolved.enum.join(" | "));
    if (resolved.minLength !== undefined || resolved.maxLength !== undefined) {
        parts.push(
            `${resolved.minLength ?? 0}–${resolved.maxLength ?? "∞"} 字符`,
        );
    }
    if (resolved.minimum !== undefined || resolved.maximum !== undefined) {
        parts.push(`${resolved.minimum ?? "-∞"}–${resolved.maximum ?? "∞"}`);
    }
    if (typeof resolved.format === "string") {
        parts.push(`格式 ${resolved.format}`);
    }
    if (resolved.default !== undefined) {
        parts.push(`缺省 ${JSON.stringify(resolved.default)}`);
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
        <Panel title="Agent 技能">
            <p className="hint">
                查看业务流程使用的 Agent 技能，了解指令、来源与关联流程。
                技能随服务发布，此处只供查看；更新需通过代码评审与发布。
            </p>
            <div className="toolbar">
                <label className="grow">
                    筛选
                    <input
                        type="search"
                        placeholder="按名称、描述或关联业务流程筛选"
                        value={query}
                        onInput={(event) => setQuery(event.currentTarget.value)}
                    />
                </label>
                <span className="hint">
                    {catalog.value
                        ? `${skills.length} / ${catalog.value.skills.length} 个`
                        : ""}
                </span>
            </div>
            {catalog.error ? <p className="error">{catalog.error}</p> : null}
            {catalog.value && skills.length === 0 ? (
                <p className="empty">
                    {catalog.value.skills.length === 0
                        ? "当前服务没有启用使用 Agent 技能的业务流程。"
                        : "没有匹配的 Skill。"}
                </p>
            ) : null}
            <div className="skill-grid">
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
            className="skill-card"
            href={hrefFor({
                view: "skill",
                name: skill.name,
                version: skill.version,
            })}
        >
            <SkillCover skill={skill} />
            <div className="skill-card-body">
                <div className="skill-card-title">
                    {skill.name}
                    <span className="skill-version">{skill.version}</span>
                </div>
                <p className="skill-card-description" title={skill.description}>
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
                className="skill-cover"
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
        <div className="skill-cover skill-cover-missing">
            <span aria-hidden="true">{initials}</span>
            <small>未提供封面</small>
        </div>
    );
}

function ProcessChips({ processes }: { processes: readonly string[] }) {
    if (processes.length === 0) {
        return <span className="hint">未被任何已启用 Process 绑定</span>;
    }
    return (
        <div className="chips">
            {processes.map((process) => (
                <span className="chip" key={process}>
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
    const back = <a href={hrefFor({ view: "skills" })}>← 返回 Agent 技能</a>;

    if (catalog.error) {
        return (
            <Panel title={`${name} @ ${version}`} action={back}>
                <p className="error">{catalog.error}</p>
            </Panel>
        );
    }
    if (!catalog.value) {
        return (
            <Panel title={`${name} @ ${version}`} action={back}>
                <p className="hint">加载中…</p>
            </Panel>
        );
    }
    if (!skill) {
        return (
            <Panel title={`${name} @ ${version}`} action={back}>
                <p className="empty">
                    本次发布没有安装这个 Skill 版本，或它未被任何已启用 Process
                    绑定。
                </p>
            </Panel>
        );
    }

    return (
        <Panel title={`${skill.name} @ ${skill.version}`} action={back}>
            <div className="skill-hero">
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
                    <p className="skill-description">
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
                                <td className="mono">{skill.sha256 || "—"}</td>
                            </tr>
                            <tr>
                                <th>封面文件</th>
                                <td className="mono">
                                    {skill.cover
                                        ? `${skill.cover.file}（${skill.cover.mediaType}）`
                                        : "无；在 Skill 目录放置 cover.png / cover.jpg / cover.webp 即可显示"}
                                </td>
                            </tr>
                            <tr>
                                <th>快照文件</th>
                                <td className="mono">
                                    {skill.files.join("　")}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <p className="hint">
                        SHA-256 只覆盖
                        SKILL.md；封面与其他随附文件不参与完整性校验。
                    </p>
                </div>
            </div>
            <CollapsibleSection
                defaultOpen
                title="SKILL.md 指令正文（Agent 实际收到的内容）"
            >
                <pre className="skill-text">{skill.instructions}</pre>
            </CollapsibleSection>
            {skill.source !== undefined ? (
                <CollapsibleSection title="SOURCE.md 来源与审查记录">
                    <pre className="skill-text">{skill.source}</pre>
                </CollapsibleSection>
            ) : null}
        </Panel>
    );
}

export function SubmitView({
    processes,
    process,
    version,
}: {
    processes: readonly ConsoleProcessDescription[];
    process?: string;
    version?: string;
}) {
    const initialSelection =
        process && version ? `${process}/${version}` : (process ?? "");
    const [selected, setSelected] = useState(initialSelection);
    const [values, setValues] = useState<Record<string, string>>({});

    useEffect(() => {
        if (process && version) {
            setSelected(`${process}/${version}`);
            setValues({});
        } else if (process) {
            const match = processes.find((p) => p.process === process);
            if (match) {
                setSelected(`${match.process}/${match.version}`);
                setValues({});
            }
        }
    }, [process, version, processes]);
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
        processes.find(
            (candidate) =>
                `${candidate.process}/${candidate.version}` === selected,
        ) ?? processes[0];
    const fields = entry ? fieldsOf(entry) : [];

    if (!entry) return <Panel title="手动调试">正在读取业务流程…</Panel>;

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
        <Panel title="手动调试">
            <p className="cost-warning">
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
                <SelectField
                    label="Business Process"
                    value={`${entry.process}/${entry.version}`}
                    options={processes.map((candidate) => ({
                        value: `${candidate.process}/${candidate.version}`,
                        label: `${candidate.process} / ${candidate.version}`,
                    }))}
                    onChange={(next) => {
                        setSelected(next);
                        setValues({});
                    }}
                />

                {fields.map((field) => {
                    const inputId = `field-${entry.process}-${field.name}`;
                    const onChange = (value: string) =>
                        setValues({ ...values, [field.name]: value });
                    return (
                        <div key={field.name}>
                            <label htmlFor={inputId}>
                                {field.name}
                                {field.required ? " *" : "（可选）"}
                            </label>
                            {field.options ? (
                                <SelectField
                                    id={inputId}
                                    value={values[field.name] ?? ""}
                                    options={[
                                        ...(field.required
                                            ? []
                                            : [
                                                  {
                                                      value: "",
                                                      label: "（不填）",
                                                  },
                                              ]),
                                        ...field.options.map((option) => ({
                                            value: option,
                                            label: option,
                                        })),
                                    ]}
                                    onChange={onChange}
                                />
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
                    className="primary"
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
            <p className="error" style={{ marginBottom: 14 }}>
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
        <div className="hint" style={{ marginBottom: 14 }}>
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
        return <p className="error">客户端发生未预期错误，请稍后重试。</p>;
    }
    if (outcome) return <Outcome result={outcome} />;
    if (!progress) return null;
    return (
        <p className="hint" style={{ marginTop: 14 }}>
            Run <code>{progress.runId}</code> 已接受，当前状态：
            <strong>{progress.status}</strong>
        </p>
    );
}

function Outcome({ result }: { result: ProcessRunOutcome }) {
    switch (result.status) {
        case "succeeded":
            return (
                <div style={{ marginTop: 14 }}>
                    <p className="status-succeeded">
                        Run <code>{result.runId}</code> · succeeded
                    </p>
                    <pre>{JSON.stringify(result.output, null, 2)}</pre>
                </div>
            );
        case "failed":
            return (
                <div style={{ marginTop: 14 }}>
                    <p className="status-failed">
                        Run <code>{result.runId}</code> · failed
                    </p>
                    <p className="error">
                        {result.error.code}：{result.error.message}
                    </p>
                </div>
            );
        case "result-expired":
            return (
                <p className="error" style={{ marginTop: 14 }}>
                    Run <code>{result.runId}</code> 已 {result.resultStatus}，
                    结果于 {formatTime(result.resultExpiredAt)} 过期。
                </p>
            );
        case "timed-out":
            return (
                <p className="error" style={{ marginTop: 14 }}>
                    Run <code>{result.runId}</code> 查询超过
                    {result.timeoutMs / 1_000} 秒；服务端仍会继续执行。
                </p>
            );
        case "cancelled":
            return (
                <p className="error" style={{ marginTop: 14 }}>
                    已停止查询 Run <code>{result.runId}</code>
                    ；服务端不会收到取消请求，之后仍可继续查询。
                </p>
            );
        case "rejected":
            return (
                <p className="error" style={{ marginTop: 14 }}>
                    HTTP {result.httpStatus} · {result.error.code}：
                    {result.error.message}
                </p>
            );
        case "protocol-error":
            return (
                <p className="error" style={{ marginTop: 14 }}>
                    服务响应不符合 Process Run Interface：{result.code}
                </p>
            );
        case "submission-pending":
            return result.classification === "acceptance-unknown" ? (
                <p className="error" style={{ marginTop: 14 }}>
                    提交响应丢失，服务端是否接受尚不确定。请重试同一操作，客户端会复用原幂等键。
                </p>
            ) : (
                <p className="error" style={{ marginTop: 14 }}>
                    HTTP {result.httpStatus} · {result.error.code}
                    ：服务暂不可接受新 Run；建议 {result.retryAfterMs / 1_000}{" "}
                    秒后重试同一操作。
                </p>
            );
        case "recovery-error":
            return (
                <p className="error" style={{ marginTop: 14 }}>
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
type FieldDescription = {
    name: string;
    required: boolean;
    options?: readonly string[];
    long: boolean;
};

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
