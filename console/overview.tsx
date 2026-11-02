/** 用量概览与异常分析复用统计快照，按相同窗口下钻记录。 */
import { useEffect, useState } from "preact/hooks";
import { type ConsoleStats, type RunFilters, readStats } from "./api.js";
import { explainError } from "./diagnostics.js";
import { formatDuration, formatTime, Panel } from "./formatting.jsx";
import { processName } from "./labels.js";
import { useAsync } from "./resource.js";
import { hrefFor } from "./routing.js";

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
            <div class="page-heading">
                <div>
                    <h1>{exceptions ? "异常排查" : "运行概览"}</h1>
                    <p class="hint">
                        {exceptions
                            ? "按业务版本与错误码归类，沿记录追查失败阶段。"
                            : "观察业务调用、成功交付与需要关注的异常。"}
                    </p>
                </div>
                <div class="actions overview-controls">
                    <label class="compact-label">
                        统计窗口
                        <select
                            aria-label="统计窗口"
                            value={hours}
                            onChange={(event) => {
                                location.hash = hrefFor({
                                    view: exceptions
                                        ? "exceptions"
                                        : "overview",
                                    hours: Number(event.currentTarget.value),
                                });
                            }}
                        >
                            <option value="1">最近 1 小时</option>
                            <option value="24">最近 24 小时</option>
                            <option value="168">最近 7 天</option>
                            <option value="720">最近 30 天</option>
                        </select>
                    </label>
                    <button
                        type="button"
                        disabled={result.loading}
                        onClick={() => setTick((value) => value + 1)}
                    >
                        刷新
                    </button>
                </div>
            </div>
            <div class="data-note">
                <label class="check">
                    <input
                        type="checkbox"
                        checked={refresh}
                        onChange={(event) =>
                            setRefresh(event.currentTarget.checked)
                        }
                    />
                    每 30 秒刷新
                </label>
                <span>
                    {result.loading
                        ? "正在读取统计…"
                        : result.updatedAt
                          ? `读取于 ${formatTime(result.updatedAt)}`
                          : "尚未取得统计"}
                </span>
            </div>
            {result.error ? (
                <div class="notice" role="alert">
                    {result.error} 当前无法判断调用量与异常情况。
                </div>
            ) : null}
            {stats ? (
                <>
                    <p class="hint window-note">
                        {formatTime(stats.since)} 至{" "}
                        {stats.until ? formatTime(stats.until) : "本次查询"}
                        。仅统计已归档终态；不代表活跃用户数或正在执行的任务。
                    </p>
                    {exceptions ? (
                        <FailureGroups stats={stats} />
                    ) : (
                        <>
                            <Metrics stats={stats} />
                            <div class="overview-grid">
                                <Panel title="调用趋势">
                                    <DailyChart stats={stats} />
                                </Panel>
                                <Panel title="最近成功">
                                    <p class="latest-success">
                                        {stats.latestSucceededAt
                                            ? formatTime(
                                                  stats.latestSucceededAt,
                                              )
                                            : stats.totals.succeeded
                                              ? "当前接口未提供时间"
                                              : "此窗口内暂无成功记录"}
                                    </p>
                                    <p class="hint">
                                        调用方与用户身份尚未采集；不能据执行次数推算人数。
                                    </p>
                                    <hr />
                                    <p>
                                        API 当前进程并发{" "}
                                        <strong>
                                            {stats.concurrency.active} /{" "}
                                            {stats.concurrency.limit}
                                        </strong>
                                    </p>
                                    <p class="hint">
                                        不含其他实例及异步 Worker。
                                    </p>
                                </Panel>
                            </div>
                            <FailureGroups stats={stats} compact />
                            <Panel title="业务用量">
                                {stats.byProcess.length ? (
                                    <div class="table-scroll">
                                        <table>
                                            <thead>
                                                <tr>
                                                    <th>业务 / 版本</th>
                                                    <th class="numeric">
                                                        执行
                                                    </th>
                                                    <th class="numeric">
                                                        成功率
                                                    </th>
                                                    <th class="numeric">
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
                                                                    <span class="cell-meta">
                                                                        {
                                                                            entry.process
                                                                        }{" "}
                                                                        /{" "}
                                                                        {
                                                                            entry.version
                                                                        }
                                                                    </span>
                                                                </td>
                                                                <td class="numeric">
                                                                    {total}
                                                                </td>
                                                                <td class="numeric">
                                                                    {total
                                                                        ? `${((entry.succeeded / total) * 100).toFixed(1)}%`
                                                                        : "—"}
                                                                </td>
                                                                <td class="numeric">
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
                                    <p class="empty">
                                        此窗口内没有业务记录。可扩大统计窗口查看。
                                    </p>
                                )}
                            </Panel>
                        </>
                    )}
                    <Panel title="最近失败">
                        {stats.recentFailures.length ? (
                            <div class="table-scroll">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>记录时间</th>
                                            <th>业务</th>
                                            <th>失败摘要</th>
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
                                                    <span class="cell-meta">
                                                        {entry.process} /{" "}
                                                        {entry.version}
                                                    </span>
                                                </td>
                                                <td>
                                                    {
                                                        explainError(
                                                            entry.errorCode,
                                                        ).title
                                                    }
                                                    <span class="cell-meta">
                                                        {entry.errorCode}
                                                    </span>
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
                            <p class="empty">此窗口内没有已归档的失败记录。</p>
                        )}
                        <p class="hint">
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
    return (
        <div class="metrics">
            <a class="metric" href={recordsHref(stats)}>
                <span>执行次数</span>
                <strong>{total}</strong>
                <small>已归档结果</small>
            </a>
            <a
                class="metric"
                href={recordsHref(stats, { status: "succeeded" })}
            >
                <span>成功率</span>
                <strong>
                    {total
                        ? `${((stats.totals.succeeded / total) * 100).toFixed(1)}%`
                        : "—"}
                </strong>
                <small>{stats.totals.succeeded} 次成功</small>
            </a>
            <a class="metric" href={recordsHref(stats, { status: "failed" })}>
                <span>失败次数</span>
                <strong>{stats.totals.failed}</strong>
                <small>查看对应记录</small>
            </a>
            <div class="metric">
                <span>Attempt 耗时 P95</span>
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
                <p class="notice">
                    当前服务尚未提供异常聚合，请通过最近失败与运行记录排查。
                </p>
            ) : !groups.length ? (
                <p class="empty">此窗口内没有已归档的失败记录。</p>
            ) : (
                <div class="table-scroll">
                    <table>
                        <thead>
                            <tr>
                                <th>业务 / 版本</th>
                                <th>错误与排查方向</th>
                                <th class="numeric">次数</th>
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
                                                <span class="cell-meta">
                                                    {group.process} /{" "}
                                                    {group.version}
                                                </span>
                                            </td>
                                            <td>
                                                <span class="status-failed">
                                                    {error.title}
                                                </span>
                                                <code class="cell-meta">
                                                    {group.errorCode}
                                                </code>
                                                {!compact ? (
                                                    <p class="hint diagnosis">
                                                        {error.next}
                                                    </p>
                                                ) : null}
                                            </td>
                                            <td class="numeric">
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
    const max = Math.max(1, ...days.map((day) => day.succeeded + day.failed));
    return (
        <>
            <section
                class="chart"
                aria-label="UTC 每日执行次数，点击查看当天记录"
            >
                {days.map((day) => (
                    <a
                        class="chart-column"
                        key={day.day}
                        aria-label={`${day.day} UTC，成功 ${day.succeeded} 次，失败 ${day.failed} 次`}
                        title={`${day.day} UTC：成功 ${day.succeeded}，失败 ${day.failed}`}
                        href={recordsHref(stats, {
                            since:
                                day.day === stats.since.slice(0, 10)
                                    ? stats.since
                                    : `${day.day}T00:00:00.000Z`,
                            until:
                                stats.until &&
                                day.day === stats.until.slice(0, 10)
                                    ? stats.until
                                    : new Date(
                                          Date.parse(`${day.day}T00:00:00Z`) +
                                              86_400_000,
                                      ).toISOString(),
                        })}
                    >
                        <span class="chart-track">
                            <span
                                class="bar-failed"
                                style={{
                                    height: `${(day.failed / max) * 100}%`,
                                }}
                            />
                            <span
                                class="bar-success"
                                style={{
                                    height: `${(day.succeeded / max) * 100}%`,
                                }}
                            />
                        </span>
                        <span class="chart-date">{day.day.slice(5)}</span>
                    </a>
                ))}
            </section>
            <div class="chart-legend">
                <span>成功</span>
                <span>失败</span>
                <span>
                    每日次数，峰值 {max === 1 && !stats.byDay.length ? 0 : max}
                    ；UTC 日界
                </span>
            </div>
        </>
    );
}
