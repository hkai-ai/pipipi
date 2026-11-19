/** 用量概览与异常分析复用统计快照，按相同窗口下钻记录。 */
import { Tooltip } from "@base-ui/react/tooltip";
import {
    Activity,
    AlertCircle,
    CheckCircle2,
    Clock,
    RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type ConsoleStats, type RunFilters, readStats } from "./api.js";
import { explainError } from "./diagnostics.js";
import { formatDuration, formatTime, Panel } from "./formatting.jsx";
import { processName } from "./labels.js";
import { useAsync } from "./resource.js";
import { hrefFor } from "./routing.js";
import { CheckboxField, SelectField } from "./ui.jsx";

export function Overview({
    hours = 24,
    exceptions = false,
}: {
    hours?: number;
    exceptions?: boolean;
}) {
    const [tick, setTick] = useState(0);
    const [refresh, setRefresh] = useState(false);
    const result = useAsync(() => readStats(hours), [hours, tick]);
    useEffect(() => {
        if (!refresh) return;
        const timer = setInterval(() => {
            if (!document.hidden) setTick((value) => value + 1);
        }, 30_000);
        return () => clearInterval(timer);
    }, [refresh]);
    const stats = result.value;
    return (
        <>
            <div className="page-heading">
                <div>
                    <h1>{exceptions ? "异常排查" : "运行概览"}</h1>
                    <p className="hint">
                        {exceptions
                            ? "按业务版本与错误码归类，沿记录追查失败阶段。"
                            : "观察业务调用、成功交付与需要关注的异常。"}
                    </p>
                </div>
                <div className="actions overview-controls">
                    <SelectField
                        label="统计窗口"
                        labelClassName="compact-label"
                        value={String(hours)}
                        options={[
                            { value: "1", label: "最近 1 小时" },
                            { value: "24", label: "最近 24 小时" },
                            { value: "168", label: "最近 7 天" },
                            { value: "720", label: "最近 30 天" },
                        ]}
                        onChange={(next) => {
                            location.hash = hrefFor({
                                view: exceptions ? "exceptions" : "overview",
                                hours: Number(next),
                            });
                        }}
                    />
                    <button
                        type="button"
                        className="btn-with-icon"
                        disabled={result.loading}
                        onClick={() => setTick((value) => value + 1)}
                    >
                        <RefreshCw
                            size={14}
                            strokeWidth={1.75}
                            aria-hidden="true"
                        />
                        <span>刷新</span>
                    </button>
                </div>
            </div>
            <div className="data-note">
                <CheckboxField
                    className="check"
                    checked={refresh}
                    onCheckedChange={setRefresh}
                    label="每 30 秒刷新"
                />
                <span>
                    {result.loading
                        ? "正在读取统计…"
                        : result.updatedAt
                          ? `读取于 ${formatTime(result.updatedAt)}`
                          : "尚未取得统计"}
                </span>
            </div>
            {result.error ? (
                <div className="notice" role="alert">
                    {result.error} 当前无法判断调用量与异常情况。
                </div>
            ) : null}
            {stats ? (
                <>
                    <p className="hint window-note">
                        {formatTime(stats.since)} 至{" "}
                        {stats.until ? formatTime(stats.until) : "本次查询"}
                        。仅统计已归档终态；不代表活跃用户数或正在执行的任务。
                    </p>
                    {exceptions ? (
                        <FailureGroups stats={stats} />
                    ) : (
                        <>
                            <Metrics stats={stats} />
                            <div className="overview-grid">
                                <Panel title="调用趋势">
                                    <DailyChart stats={stats} />
                                </Panel>
                                <Panel title="最近成功">
                                    <p className="latest-success">
                                        <span
                                            className="live-dot"
                                            aria-hidden="true"
                                        />
                                        <span>
                                            {stats.latestSucceededAt
                                                ? formatTime(
                                                      stats.latestSucceededAt,
                                                  )
                                                : stats.totals.succeeded
                                                  ? "当前接口未提供时间"
                                                  : "此窗口内暂无成功记录"}
                                        </span>
                                    </p>
                                    <p className="hint">
                                        调用方与用户身份尚未采集；不能据执行次数推算人数。
                                    </p>
                                    <hr />
                                    <div className="concurrency-header">
                                        <span>API 当前进程并发</span>
                                        <strong className="numeric">
                                            {stats.concurrency.active} /{" "}
                                            {stats.concurrency.limit}
                                        </strong>
                                    </div>
                                    <div
                                        className="rate-bar concurrency-bar"
                                        aria-hidden="true"
                                    >
                                        <span
                                            className="rate-bar-fill rate-good"
                                            style={{
                                                width: `${
                                                    stats.concurrency.limit > 0
                                                        ? Math.min(
                                                              100,
                                                              (stats.concurrency
                                                                  .active /
                                                                  stats
                                                                      .concurrency
                                                                      .limit) *
                                                                  100,
                                                          )
                                                        : 0
                                                }%`,
                                            }}
                                        />
                                    </div>
                                    <p className="hint">
                                        不含其他实例及异步 Worker。
                                    </p>
                                </Panel>
                            </div>
                            <FailureGroups stats={stats} compact />
                            <Panel title="业务用量">
                                {stats.byProcess.length ? (
                                    <div className="table-scroll">
                                        <table>
                                            <thead>
                                                <tr>
                                                    <th>业务 / 版本</th>
                                                    <th className="numeric">
                                                        执行
                                                    </th>
                                                    <th className="numeric">
                                                        成功率
                                                    </th>
                                                    <th className="numeric">
                                                        失败
                                                    </th>
                                                    <th>记录</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {stats.byProcess.map(
                                                    (entry) => {
                                                        const total =
                                                            entry.succeeded +
                                                            entry.failed;
                                                        return (
                                                            <tr
                                                                key={`${entry.process}/${entry.version}`}
                                                            >
                                                                <td>
                                                                    <strong>
                                                                        {processName(
                                                                            entry.process,
                                                                        )}
                                                                    </strong>
                                                                    <span className="cell-meta">
                                                                        {
                                                                            entry.process
                                                                        }{" "}
                                                                        /{" "}
                                                                        {
                                                                            entry.version
                                                                        }
                                                                    </span>
                                                                </td>
                                                                <td className="numeric">
                                                                    {total}
                                                                </td>
                                                                <td className="numeric">
                                                                    {total ? (
                                                                        <div className="rate-cell">
                                                                            <span className="rate-bar">
                                                                                <span
                                                                                    className={`rate-bar-fill ${
                                                                                        entry.succeeded /
                                                                                            total >=
                                                                                        0.9
                                                                                            ? "rate-good"
                                                                                            : entry.succeeded /
                                                                                                    total >=
                                                                                                0.5
                                                                                              ? "rate-warn"
                                                                                              : "rate-bad"
                                                                                    }`}
                                                                                    style={{
                                                                                        width: `${((entry.succeeded / total) * 100).toFixed(1)}%`,
                                                                                    }}
                                                                                />
                                                                            </span>
                                                                            <span>
                                                                                {(
                                                                                    (entry.succeeded /
                                                                                        total) *
                                                                                    100
                                                                                ).toFixed(
                                                                                    1,
                                                                                )}
                                                                                %
                                                                            </span>
                                                                        </div>
                                                                    ) : (
                                                                        "—"
                                                                    )}
                                                                </td>
                                                                <td className="numeric">
                                                                    {entry.failed ? (
                                                                        <a
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
                                                                            {
                                                                                entry.failed
                                                                            }
                                                                        </a>
                                                                    ) : (
                                                                        0
                                                                    )}
                                                                </td>
                                                                <td>
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
                                                                        查看记录
                                                                    </a>
                                                                </td>
                                                            </tr>
                                                        );
                                                    },
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                ) : (
                                    <p className="empty">
                                        此窗口内没有业务记录。可扩大统计窗口查看。
                                    </p>
                                )}
                            </Panel>
                        </>
                    )}
                    <Panel title="最近失败">
                        {stats.recentFailures.length ? (
                            <div className="table-scroll">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>记录时间</th>
                                            <th>业务 / 调用方</th>
                                            <th>失败摘要与字段定位</th>
                                            <th>详情</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {stats.recentFailures.map((entry) => (
                                            <tr key={entry.runId}>
                                                <td>
                                                    {formatTime(
                                                        entry.recordedAt,
                                                    )}
                                                </td>
                                                <td>
                                                    {processName(entry.process)}
                                                    <span className="cell-meta">
                                                        {entry.process} /{" "}
                                                        {entry.version}
                                                    </span>
                                                    {entry.callerId ? (
                                                        <span className="cell-meta mono">
                                                            caller:{" "}
                                                            {entry.callerId}
                                                        </span>
                                                    ) : null}
                                                </td>
                                                <td>
                                                    {
                                                        explainError(
                                                            entry.errorCode,
                                                        ).title
                                                    }
                                                    <span className="cell-meta mono">
                                                        {entry.failureDetail
                                                            ?.httpStatus
                                                            ? `HTTP ${entry.failureDetail.httpStatus} · `
                                                            : ""}
                                                        {entry.errorCode}
                                                        {entry.failureDetail
                                                            ?.idempotencyKey
                                                            ? ` · key: ${entry.failureDetail.idempotencyKey}`
                                                            : ""}
                                                    </span>
                                                    {entry.failureDetail
                                                        ?.details?.length ? (
                                                        <span className="cell-meta mono">
                                                            {entry.failureDetail.details
                                                                .slice(0, 2)
                                                                .map(
                                                                    (d) =>
                                                                        `${d.path} (${d.message})`,
                                                                )
                                                                .join("；")}
                                                        </span>
                                                    ) : null}
                                                </td>
                                                <td>
                                                    <a
                                                        href={hrefFor({
                                                            view: "run",
                                                            runId: entry.runId,
                                                            back: hrefFor({
                                                                view: exceptions
                                                                    ? "exceptions"
                                                                    : "overview",
                                                                hours,
                                                            }),
                                                        })}
                                                    >
                                                        查看详情
                                                    </a>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <p className="empty">
                                此窗口内没有已归档的失败记录。
                            </p>
                        )}
                        <p className="hint">
                            最多展示最近 10 条；上方异常聚合覆盖完整查询窗口。
                        </p>
                    </Panel>
                </>
            ) : null}
        </>
    );
}

function Metrics({ stats }: { stats: ConsoleStats }) {
    const total = stats.totals.succeeded + stats.totals.failed;
    const rate = total ? (stats.totals.succeeded / total) * 100 : undefined;
    return (
        <div className="metrics">
            <a className="metric" href={recordsHref(stats)}>
                <div className="metric-head">
                    <span>执行次数</span>
                    <Activity size={15} strokeWidth={1.75} aria-hidden="true" />
                </div>
                <strong>{total}</strong>
                <small>已归档结果</small>
            </a>
            <a
                className="metric"
                href={recordsHref(stats, { status: "succeeded" })}
            >
                <div className="metric-head">
                    <span>成功率</span>
                    <CheckCircle2
                        size={15}
                        strokeWidth={1.75}
                        className="metric-icon-ok"
                        aria-hidden="true"
                    />
                </div>
                <strong>
                    {rate !== undefined ? `${rate.toFixed(1)}%` : "—"}
                </strong>
                {rate !== undefined ? (
                    <div className="metric-bar" aria-hidden="true">
                        <span
                            className={`rate-bar-fill ${rate >= 90 ? "rate-good" : rate >= 50 ? "rate-warn" : "rate-bad"}`}
                            style={{ width: `${rate.toFixed(1)}%` }}
                        />
                    </div>
                ) : null}
                <small>{stats.totals.succeeded} 次成功</small>
            </a>
            <a
                className="metric"
                href={recordsHref(stats, { status: "failed" })}
            >
                <div className="metric-head">
                    <span>失败次数</span>
                    <AlertCircle
                        size={15}
                        strokeWidth={1.75}
                        className={
                            stats.totals.failed > 0
                                ? "metric-icon-bad"
                                : undefined
                        }
                        aria-hidden="true"
                    />
                </div>
                <strong>{stats.totals.failed}</strong>
                <small>查看对应记录</small>
            </a>
            <div className="metric">
                <div className="metric-head">
                    <span>Attempt 耗时 P95</span>
                    <Clock size={15} strokeWidth={1.75} aria-hidden="true" />
                </div>
                <strong>{formatDuration(stats.attemptDurationMs.p95)}</strong>
                <small>
                    {stats.attemptDurationMs.samples} 次采样；非端到端耗时
                </small>
            </div>
        </div>
    );
}

function FailureGroups({
    stats,
    compact = false,
}: {
    stats: ConsoleStats;
    compact?: boolean;
}) {
    const groups = stats.failures;
    return (
        <Panel title={compact ? "需要关注" : "异常聚合"}>
            {!groups ? (
                <p className="notice">
                    当前服务尚未提供异常聚合，请通过最近失败与运行记录排查。
                </p>
            ) : !groups.length ? (
                <p className="empty">此窗口内没有已归档的失败记录。</p>
            ) : (
                <div className="table-scroll">
                    <table>
                        <thead>
                            <tr>
                                <th>业务 / 版本</th>
                                <th>错误与排查方向</th>
                                <th className="numeric">次数</th>
                                <th>最近发生</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(compact ? groups.slice(0, 3) : groups).map(
                                (group) => {
                                    const error = explainError(group.errorCode);
                                    return (
                                        <tr
                                            key={`${group.process}/${group.version}/${group.errorCode}`}
                                        >
                                            <td>
                                                <strong>
                                                    {processName(group.process)}
                                                </strong>
                                                <span className="cell-meta">
                                                    {group.process} /{" "}
                                                    {group.version}
                                                </span>
                                            </td>
                                            <td>
                                                <span className="status-failed">
                                                    {error.title}
                                                </span>
                                                <code className="cell-meta code-pill">
                                                    {group.errorCode}
                                                </code>
                                                {!compact ? (
                                                    <p className="hint diagnosis">
                                                        {error.next}
                                                    </p>
                                                ) : null}
                                            </td>
                                            <td className="numeric">
                                                {group.count}
                                            </td>
                                            <td>
                                                {group.latestAt
                                                    ? formatTime(group.latestAt)
                                                    : "未提供"}
                                            </td>
                                            <td>
                                                <a
                                                    href={recordsHref(stats, {
                                                        process: group.process,
                                                        version: group.version,
                                                        status: "failed",
                                                        errorCode:
                                                            group.errorCode,
                                                    })}
                                                >
                                                    排查记录
                                                </a>
                                            </td>
                                        </tr>
                                    );
                                },
                            )}
                        </tbody>
                    </table>
                </div>
            )}
            {compact && groups && groups.length > 3 ? (
                <a
                    href={hrefFor({
                        view: "exceptions",
                        hours: stats.until
                            ? Math.round(
                                  (Date.parse(stats.until) -
                                      Date.parse(stats.since)) /
                                      3_600_000,
                              )
                            : 24,
                    })}
                >
                    查看全部 {groups.length} 类异常
                </a>
            ) : null}
        </Panel>
    );
}

export function recordsHref(
    stats: Pick<ConsoleStats, "since" | "until">,
    filters: RunFilters = {},
) {
    return hrefFor({
        view: "runs",
        filters: { since: stats.since, until: stats.until, ...filters },
    });
}

function DailyChart({ stats }: { stats: ConsoleStats }) {
    const start = new Date(stats.since.slice(0, 10));
    const end = new Date(
        new Date(Date.parse(stats.until ?? new Date().toISOString()) - 1)
            .toISOString()
            .slice(0, 10),
    );
    const days = [];
    for (
        let date = start.getTime();
        date <= end.getTime() && days.length < 32;
        date += 86_400_000
    ) {
        const day = new Date(date).toISOString().slice(0, 10);
        days.push(
            stats.byDay.find((entry) => entry.day === day) ?? {
                day,
                succeeded: 0,
                failed: 0,
            },
        );
    }
    const peak = Math.max(1, ...days.map((day) => day.succeeded + day.failed));
    const hasData = stats.byDay.length > 0;
    const ticks = hasData ? [peak, Math.round(peak / 2), 0] : [0];
    return (
        <>
            <div className="chart-shell">
                <div className="chart-yaxis" aria-hidden="true">
                    {ticks.map((tick) => (
                        <span key={tick}>{tick}</span>
                    ))}
                </div>
                <section
                    className="chart"
                    aria-label="UTC 每日执行次数，点击查看当天记录"
                >
                    <div className="chart-grid" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                    </div>
                    {days.map((day) => {
                        const total = day.succeeded + day.failed;
                        return (
                            <Tooltip.Root key={day.day}>
                                <Tooltip.Trigger
                                    delay={0}
                                    closeDelay={50}
                                    render={
                                        <a
                                            className="chart-column"
                                            aria-label={`${day.day} UTC，成功 ${day.succeeded} 次，失败 ${day.failed} 次`}
                                            href={recordsHref(stats, {
                                                since:
                                                    day.day ===
                                                    stats.since.slice(0, 10)
                                                        ? stats.since
                                                        : `${day.day}T00:00:00.000Z`,
                                                until:
                                                    stats.until &&
                                                    day.day ===
                                                        stats.until.slice(0, 10)
                                                        ? stats.until
                                                        : new Date(
                                                              Date.parse(
                                                                  `${day.day}T00:00:00Z`,
                                                              ) + 86_400_000,
                                                          ).toISOString(),
                                            })}
                                        />
                                    }
                                >
                                    <span className="chart-track">
                                        {day.failed > 0 ? (
                                            <span
                                                className="bar-failed"
                                                style={{
                                                    height: `${(day.failed / peak) * 100}%`,
                                                }}
                                            />
                                        ) : null}
                                        {day.succeeded > 0 ? (
                                            <span
                                                className="bar-success"
                                                style={{
                                                    height: `${(day.succeeded / peak) * 100}%`,
                                                }}
                                            />
                                        ) : null}
                                    </span>
                                    <span className="chart-date">
                                        {day.day.slice(5)}
                                    </span>
                                </Tooltip.Trigger>
                                <Tooltip.Portal>
                                    <Tooltip.Positioner
                                        className="chart-tooltip-positioner"
                                        side="top"
                                        sideOffset={8}
                                    >
                                        <Tooltip.Popup className="chart-tooltip">
                                            <strong className="mono">
                                                {day.day} UTC
                                            </strong>
                                            <div className="chart-tooltip-row">
                                                <span>总执行</span>
                                                <span className="numeric">
                                                    {total}
                                                </span>
                                            </div>
                                            <div className="chart-tooltip-row">
                                                <span>成功</span>
                                                <span className="numeric status-ok-text">
                                                    {day.succeeded}
                                                </span>
                                            </div>
                                            <div className="chart-tooltip-row">
                                                <span>失败</span>
                                                <span className="numeric status-bad-text">
                                                    {day.failed}
                                                </span>
                                            </div>
                                        </Tooltip.Popup>
                                    </Tooltip.Positioner>
                                </Tooltip.Portal>
                            </Tooltip.Root>
                        );
                    })}
                </section>
            </div>
            <div className="chart-legend">
                <span>成功</span>
                <span>失败</span>
                <span>每日次数，峰值 {hasData ? peak : 0}；UTC 日界</span>
            </div>
        </>
    );
}
