/** 统计汇总 Interface，拥有 RunObservationSummary */
import type { ProcessRunLogRecord } from "../process-runtime/index.js";
import type { ProcessRunRecord } from "../process-runtime/records.js";

/**
 * What the service has been doing in a window, derived from the observation
 * archive. Live concurrency is not here: occupancy exists only in the process
 * serving a request, so the HTTP layer adds it.
 */
export type RunObservationSummary = Readonly<{
    since: string;
    latestSucceededAt?: string;
    failures?: readonly Readonly<{
        process: string;
        version: string;
        errorCode: string;
        count: number;
        latestAt?: string;
    }>[];
    totals: Readonly<{ succeeded: number; failed: number }>;
    byProcess: readonly Readonly<{
        process: string;
        version: string;
        succeeded: number;
        failed: number;
    }>[];
    byErrorCode: readonly Readonly<{ errorCode: string; count: number }>[];
    byDay: readonly Readonly<{
        day: string;
        succeeded: number;
        failed: number;
        byErrorCode: readonly Readonly<{
            errorCode: string;
            count: number;
        }>[];
    }>[];
    recentFailures: readonly Readonly<{
        runId: string;
        recordedAt: string;
        process: string;
        version: string;
        errorCode: string;
    }>[];
    attemptDurationMs: Readonly<{
        samples: number;
        p50?: number;
        p95?: number;
        max?: number;
    }>;
}>;

export type RunObservationStats = Readonly<{
    summarise: (
        query: Readonly<{ since: string; until?: string }>,
    ) => Promise<RunObservationSummary>;
}>;

export type RunObservationCount = Readonly<{
    day: string;
    process: string;
    version: string;
    status: "succeeded" | "failed";
    errorCode?: string;
    count: number;
    latestAt?: string;
}>;

/**
 * Summarises Run observation from already-loaded records.
 *
 * Shared by both storage Implementations so the numbers cannot disagree: the
 * file store reads its day files and hands them here, and the PostgreSQL store
 * uses the same shaping after aggregating in SQL.
 */
export function summariseRunObservation(input: {
    since: string;
    records: readonly ProcessRunRecord[];
    attemptDurationsMs: readonly number[];
}): RunObservationSummary {
    const grouped = new Map<string, RunObservationCount>();
    for (const record of input.records) {
        const count = {
            day: record.recordedAt.slice(0, 10),
            process: record.process ?? "unknown",
            version: record.version ?? "unknown",
            status: record.status,
            ...(record.errorCode ? { errorCode: record.errorCode } : {}),
        };
        const key = JSON.stringify(count);
        grouped.set(key, {
            ...count,
            count: (grouped.get(key)?.count ?? 0) + 1,
            latestAt: [grouped.get(key)?.latestAt ?? "", record.recordedAt]
                .sort()
                .at(-1),
        });
    }
    const recentFailures = input.records
        .filter(
            (
                record,
            ): record is ProcessRunRecord & Readonly<{ errorCode: string }> =>
                record.status === "failed" && record.errorCode !== undefined,
        )
        .sort(
            (left, right) =>
                right.recordedAt.localeCompare(left.recordedAt) ||
                right.runId.localeCompare(left.runId),
        )
        .slice(0, 10)
        .map((record) =>
            Object.freeze({
                runId: record.runId,
                recordedAt: record.recordedAt,
                process: record.process ?? "unknown",
                version: record.version ?? "unknown",
                errorCode: record.errorCode,
            }),
        );
    return summariseAggregatedRunObservation({
        since: input.since,
        counts: [...grouped.values()],
        recentFailures,
        attemptDurationMs: summariseDurations(input.attemptDurationsMs),
    });
}

/** Shapes SQL group rows without expanding each count back into fake Runs. */
export function summariseAggregatedRunObservation(input: {
    since: string;
    counts: readonly RunObservationCount[];
    recentFailures: RunObservationSummary["recentFailures"];
    attemptDurationMs: RunObservationSummary["attemptDurationMs"];
}): RunObservationSummary {
    const totals = { succeeded: 0, failed: 0 };
    let latestSucceededAt: string | undefined;
    const failures = new Map<
        string,
        {
            process: string;
            version: string;
            errorCode: string;
            count: number;
            latestAt?: string;
        }
    >();
    const byProcess = new Map<
        string,
        { process: string; version: string; succeeded: number; failed: number }
    >();
    const byErrorCode = new Map<string, number>();
    const byDay = new Map<
        string,
        {
            day: string;
            succeeded: number;
            failed: number;
            byErrorCode: Map<string, number>;
        }
    >();

    for (const count of input.counts) {
        totals[count.status] += count.count;
        if (
            count.status === "succeeded" &&
            count.latestAt &&
            (!latestSucceededAt || count.latestAt > latestSucceededAt)
        )
            latestSucceededAt = count.latestAt;

        const process = count.process;
        const version = count.version;
        const key = `${process}/${version}`;
        const entry = byProcess.get(key) ?? {
            process,
            version,
            succeeded: 0,
            failed: 0,
        };
        entry[count.status] += count.count;
        byProcess.set(key, entry);

        const day = count.day;
        const dayEntry = byDay.get(day) ?? {
            day,
            succeeded: 0,
            failed: 0,
            byErrorCode: new Map<string, number>(),
        };
        dayEntry[count.status] += count.count;
        byDay.set(day, dayEntry);

        if (count.status === "failed" && count.errorCode) {
            const key = JSON.stringify([process, version, count.errorCode]);
            const previous = failures.get(key);
            failures.set(key, {
                process,
                version,
                errorCode: count.errorCode,
                count: (previous?.count ?? 0) + count.count,
                latestAt:
                    [previous?.latestAt ?? "", count.latestAt ?? ""]
                        .sort()
                        .at(-1) || undefined,
            });
            byErrorCode.set(
                count.errorCode,
                (byErrorCode.get(count.errorCode) ?? 0) + count.count,
            );
            dayEntry.byErrorCode.set(
                count.errorCode,
                (dayEntry.byErrorCode.get(count.errorCode) ?? 0) + count.count,
            );
        }
    }

    return Object.freeze({
        since: input.since,
        latestSucceededAt,
        failures: Object.freeze(
            [...failures.values()].sort(
                (a, b) =>
                    b.count - a.count ||
                    `${a.process}/${a.version}/${a.errorCode}`.localeCompare(
                        `${b.process}/${b.version}/${b.errorCode}`,
                    ),
            ),
        ),
        totals: Object.freeze(totals),
        byProcess: Object.freeze(
            [...byProcess.values()].sort(
                (left, right) =>
                    right.succeeded +
                    right.failed -
                    (left.succeeded + left.failed),
            ),
        ),
        byErrorCode: Object.freeze(
            [...byErrorCode.entries()]
                .map(([errorCode, count]) => ({ errorCode, count }))
                .sort((left, right) => right.count - left.count),
        ),
        byDay: Object.freeze(
            [...byDay.values()]
                .sort((left, right) => left.day.localeCompare(right.day))
                .map((entry) =>
                    Object.freeze({
                        day: entry.day,
                        succeeded: entry.succeeded,
                        failed: entry.failed,
                        byErrorCode: Object.freeze(
                            [...entry.byErrorCode.entries()]
                                .map(([errorCode, count]) => ({
                                    errorCode,
                                    count,
                                }))
                                .sort((left, right) =>
                                    left.errorCode.localeCompare(
                                        right.errorCode,
                                    ),
                                ),
                        ),
                    }),
                ),
        ),
        recentFailures: Object.freeze(input.recentFailures),
        attemptDurationMs: input.attemptDurationMs,
    });
}

/**
 * Percentiles use nearest-rank on the sorted samples: with the handful of
 * Attempts a single synchronous instance produces in a window, interpolation
 * would invent a duration no Attempt actually took.
 */
export function summariseDurations(
    samples: readonly number[],
): RunObservationSummary["attemptDurationMs"] {
    if (samples.length === 0) return Object.freeze({ samples: 0 });
    const sorted = [...samples].sort((left, right) => left - right);
    return Object.freeze({
        samples: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1],
    });
}

function percentile(sorted: readonly number[], fraction: number): number {
    const rank = Math.ceil(fraction * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number;
}

/** Attempt-level durations are the ones an operator compares against timeouts. */
export function attemptDurationsOf(
    activities: readonly ProcessRunLogRecord[],
    since: string,
): number[] {
    return activities
        .filter(
            (record) =>
                record.event === "process_run_attempt_finished" &&
                record.timestamp >= since,
        )
        .map((record) =>
            "durationMs" in record ? record.durationMs : Number.NaN,
        )
        .filter((duration) => Number.isFinite(duration));
}
