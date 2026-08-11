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
    const totals = { succeeded: 0, failed: 0 };
    const byProcess = new Map<
        string,
        { process: string; version: string; succeeded: number; failed: number }
    >();
    const byErrorCode = new Map<string, number>();

    for (const record of input.records) {
        totals[record.status] += 1;

        const process = record.process ?? "unknown";
        const version = record.version ?? "unknown";
        const key = `${process}/${version}`;
        const entry = byProcess.get(key) ?? {
            process,
            version,
            succeeded: 0,
            failed: 0,
        };
        entry[record.status] += 1;
        byProcess.set(key, entry);

        if (record.status === "failed" && record.errorCode) {
            byErrorCode.set(
                record.errorCode,
                (byErrorCode.get(record.errorCode) ?? 0) + 1,
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
        attemptDurationMs: summariseDurations(input.attemptDurationsMs),
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
