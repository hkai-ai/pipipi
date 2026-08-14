import type { ConsoleStatsSummary } from "../api/http.js";
import type { ProcessRunLogRecord } from "../process-runtime/index.js";
import type { ProcessRunRecord } from "../process-runtime/records.js";
import { createJsonlProcessRunActivityReader } from "./process-run-activities.js";
import { createJsonlProcessRunRecordReader } from "./process-run-records.js";

export type RunObservationStats = Readonly<{
    summarise: (
        query: Readonly<{ since: string }>,
    ) => Promise<ConsoleStatsSummary>;
}>;

export type RunObservationCount = Readonly<{
    day: string;
    process: string;
    version: string;
    status: "succeeded" | "failed";
    errorCode?: string;
    count: number;
}>;

/**
 * File-backed statistics. The window is scanned on every request: at the volume
 * a single synchronous instance can produce, a full scan of the retained window
 * is milliseconds, and a cache would only add a staleness question.
 */
export function createJsonlRunObservationStats(options: {
    directory: string;
    retentionDays?: number;
    clock?: () => Date;
}): RunObservationStats {
    const readRecords = createJsonlProcessRunRecordReader(options);
    const readActivities = createJsonlProcessRunActivityReader(options);
    return Object.freeze({
        summarise: async ({ since }) =>
            summariseRunObservation({
                since,
                records: await readRecords(since),
                attemptDurationsMs: attemptDurationsOf(
                    await readActivities(since),
                    since,
                ),
            }),
    });
}

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
}): ConsoleStatsSummary {
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
    recentFailures: ConsoleStatsSummary["recentFailures"];
    attemptDurationMs: ConsoleStatsSummary["attemptDurationMs"];
}): ConsoleStatsSummary {
    const totals = { succeeded: 0, failed: 0 };
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
): ConsoleStatsSummary["attemptDurationMs"] {
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
