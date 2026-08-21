/** 同一组 Interface 的 PostgreSQL Adapter */
import type { Pool } from "pg";
import type {
    ProcessErrorCode,
    ProcessRunLogRecord,
} from "../process-runtime/index.js";
import type { ProcessRunRecord } from "../process-runtime/records.js";
import type { ProcessRunActivityArchive } from "./activities.js";
import {
    encodeProcessRunRecordCursor,
    type ProcessRunRecordArchive,
    parseProcessRunRecordCursor,
    parseProcessRunRecordListLimit,
    redactProcessRunRecord,
} from "./records.js";
import {
    type RunObservationStats,
    summariseAggregatedRunObservation,
} from "./stats.js";

/**
 * PostgreSQL-backed Run Record archive.
 *
 * Same Adapter as the JSONL archive, chosen in production because the database
 * is backed up and because listing, filtering and aggregation are queries
 * rather than hand-written scans. It observes only: nothing reads these rows to
 * decide business state, retries or delivery.
 */
export function createPostgresProcessRunRecordArchive(options: {
    pool: Pool;
}): ProcessRunRecordArchive {
    const pool = options.pool;

    return Object.freeze({
        store: async (record) => {
            const safe = redactProcessRunRecord(record);
            // A replayed runId reports its latest outcome, matching the file
            // archive where later lines win.
            await pool.query(
                `insert into process_run_records
                   (run_id, recorded_at, process_id, process_version,
                    status, error_code, content)
                 values ($1, $2, $3, $4, $5, $6, $7)
                 on conflict (run_id) do update set
                   recorded_at = excluded.recorded_at,
                   process_id = excluded.process_id,
                   process_version = excluded.process_version,
                   status = excluded.status,
                   error_code = excluded.error_code,
                   content = excluded.content`,
                [
                    safe.runId,
                    safe.recordedAt,
                    safe.process ?? null,
                    safe.version ?? null,
                    safe.status,
                    safe.errorCode ?? null,
                    safe.content ? JSON.stringify(safe.content) : null,
                ],
            );
        },

        find: async (runId) => {
            const { rows } = await pool.query(
                `${recordSelect} where run_id = $1`,
                [runId],
            );
            const row = rows[0];
            return row ? toRecord(row) : undefined;
        },

        list: async (query = {}) => {
            const limit = parseProcessRunRecordListLimit(query.limit);
            const before = parseProcessRunRecordCursor(query.before);
            const { rows } = await pool.query(
                `${recordSelect}
                 where ($1::timestamptz is null
                        or recorded_at < $1::timestamptz
                        or (recorded_at = $1::timestamptz
                            and $8::text is not null
                            and run_id < $8::text))
                   and ($3::text is null or process_id = $3::text)
                   and ($4::text is null or status = $4::text)
                   and ($5::text is null or error_code = $5::text)
                   and ($6::timestamptz is null or recorded_at >= $6::timestamptz)
                   and ($7::timestamptz is null or recorded_at < $7::timestamptz)
                 order by recorded_at desc, run_id desc
                 limit $2`,
                [
                    before?.recordedAt ?? null,
                    limit + 1,
                    query.process ?? null,
                    query.status ?? null,
                    query.errorCode ?? null,
                    query.since ?? null,
                    query.until ?? null,
                    before?.runId ?? null,
                ],
            );
            const records = rows.slice(0, limit).map(toRecord);
            return Object.freeze(
                rows.length > limit
                    ? {
                          records: Object.freeze(records),
                          nextBefore: records.at(-1)
                              ? encodeProcessRunRecordCursor(
                                    records.at(-1) as ProcessRunRecord,
                                )
                              : undefined,
                      }
                    : { records: Object.freeze(records) },
            );
        },
    });
}

/**
 * PostgreSQL-backed activity archive. Writes are append-only and best effort:
 * a failure here leaves the Pino Sink and the Process Run result untouched.
 */
export function createPostgresProcessRunActivityArchive(options: {
    pool: Pool;
}): ProcessRunActivityArchive {
    const pool = options.pool;
    const pending = new Set<Promise<void>>();

    return Object.freeze({
        record: (record) => {
            const write = pool
                .query(
                    `insert into process_run_activities
                       (run_id, recorded_at, process_id, process_version,
                        attempt_number, sequence, event, activity, outcome,
                        duration_ms, error_code)
                     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [
                        record.runId,
                        record.timestamp,
                        record.process,
                        record.version,
                        record.attemptNumber,
                        record.sequence,
                        record.event,
                        "activity" in record ? record.activity : null,
                        "outcome" in record ? record.outcome : null,
                        "durationMs" in record ? record.durationMs : null,
                        "errorCode" in record ? record.errorCode : null,
                    ],
                )
                .then(
                    () => {},
                    () => {},
                );
            pending.add(write);
            void write.finally(() => pending.delete(write));
        },

        flush: async () => {
            await Promise.all([...pending]);
        },

        findByRun: async (runId) => {
            const { rows } = await pool.query(
                `select run_id, recorded_at, process_id, process_version,
                        attempt_number, sequence, event, activity, outcome,
                        duration_ms, error_code
                   from process_run_activities
                  where run_id = $1
                  order by attempt_number, sequence, id`,
                [runId],
            );
            return Object.freeze(rows.map(toActivity));
        },
    });
}

/**
 * PostgreSQL-backed statistics. Aggregation happens in the database rather than
 * by loading the window into the service, which is the main reason production
 * uses this store rather than files.
 */
export function createPostgresRunObservationStats(options: {
    pool: Pool;
}): RunObservationStats {
    const pool = options.pool;

    return Object.freeze({
        summarise: async ({ since }) => {
            const [counts, durations, recentFailures] = await Promise.all([
                pool.query(
                    `select to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD') as day,
                            coalesce(process_id, 'unknown') as process_id,
                            coalesce(process_version, 'unknown') as process_version,
                            status, error_code, count(*)::int as count
                       from process_run_records
                      where recorded_at >= $1
                      group by 1, 2, 3, 4, 5`,
                    [since],
                ),
                pool.query(
                    `select count(*)::int as samples,
                            percentile_disc(0.5) within group (order by duration_ms) as p50,
                            percentile_disc(0.95) within group (order by duration_ms) as p95,
                            max(duration_ms) as max
                       from process_run_activities
                      where recorded_at >= $1
                        and event = 'process_run_attempt_finished'
                        and duration_ms is not null`,
                    [since],
                ),
                pool.query(
                    `select run_id, recorded_at,
                            coalesce(process_id, 'unknown') as process_id,
                            coalesce(process_version, 'unknown') as process_version,
                            error_code
                       from process_run_records
                      where recorded_at >= $1
                        and status = 'failed'
                        and error_code is not null
                      order by recorded_at desc, run_id desc
                      limit 10`,
                    [since],
                ),
            ]);

            const duration = durations.rows[0] as DurationRow | undefined;
            return summariseAggregatedRunObservation({
                since,
                counts: counts.rows.map((row: CountRow) => ({
                    day: row.day,
                    process: row.process_id,
                    version: row.process_version,
                    status: row.status,
                    ...(row.error_code === null
                        ? {}
                        : { errorCode: row.error_code }),
                    count: row.count,
                })),
                recentFailures: Object.freeze(
                    recentFailures.rows.map(toRecentFailure),
                ),
                attemptDurationMs: Object.freeze(
                    duration && duration.samples > 0
                        ? {
                              samples: duration.samples,
                              p50: duration.p50 ?? undefined,
                              p95: duration.p95 ?? undefined,
                              max: duration.max ?? undefined,
                          }
                        : { samples: 0 },
                ),
            });
        },
    });
}

type CountRow = Readonly<{
    day: string;
    process_id: string;
    process_version: string;
    status: "succeeded" | "failed";
    error_code: string | null;
    count: number;
}>;

type RecentFailureRow = Readonly<{
    run_id: string;
    recorded_at: Date;
    process_id: string;
    process_version: string;
    error_code: string;
}>;

type DurationRow = Readonly<{
    samples: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
}>;

/**
 * Deletes observation rows outside the retention window. Both tables are
 * trimmed by the same window so a Run never keeps a timeline without its
 * record, or the other way round.
 */
export async function pruneProcessRunObservation(options: {
    pool: Pool;
    retentionDays: number;
    now?: Date;
}): Promise<void> {
    const cutoff = new Date(
        (options.now ?? new Date()).getTime() -
            options.retentionDays * 86_400_000,
    ).toISOString();
    await options.pool.query(
        "delete from process_run_activities where recorded_at < $1",
        [cutoff],
    );
    await options.pool.query(
        "delete from process_run_records where recorded_at < $1",
        [cutoff],
    );
}

const recordSelect = `select run_id, recorded_at, process_id, process_version,
                             status, error_code, content
                        from process_run_records`;

type RecordRow = Readonly<{
    run_id: string;
    recorded_at: Date;
    process_id: string | null;
    process_version: string | null;
    status: "succeeded" | "failed";
    error_code: string | null;
    content: unknown;
}>;

type ActivityRow = Readonly<{
    run_id: string;
    recorded_at: Date;
    process_id: string;
    process_version: string;
    attempt_number: number;
    sequence: number;
    event: string;
    activity: string | null;
    outcome: string | null;
    duration_ms: number | null;
    error_code: string | null;
}>;

function toRecord(row: RecordRow): ProcessRunRecord {
    return {
        schemaVersion: 1,
        recordedAt: row.recorded_at.toISOString(),
        runId: row.run_id,
        ...(row.process_id === null ? {} : { process: row.process_id }),
        ...(row.process_version === null
            ? {}
            : { version: row.process_version }),
        status: row.status,
        ...(row.error_code === null
            ? {}
            : { errorCode: row.error_code as ProcessErrorCode }),
        ...(row.content === null
            ? {}
            : { content: row.content as ProcessRunRecord["content"] }),
    } as ProcessRunRecord;
}

function toActivity(row: ActivityRow): ProcessRunLogRecord {
    return {
        schemaVersion: 1,
        timestamp: row.recorded_at.toISOString(),
        runId: row.run_id,
        process: row.process_id,
        version: row.process_version,
        attemptNumber: row.attempt_number,
        sequence: row.sequence,
        event: row.event,
        ...(row.activity === null ? {} : { activity: row.activity }),
        ...(row.outcome === null ? {} : { outcome: row.outcome }),
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    } as ProcessRunLogRecord;
}

function toRecentFailure(row: RecentFailureRow) {
    return Object.freeze({
        runId: row.run_id,
        recordedAt: row.recorded_at.toISOString(),
        process: row.process_id,
        version: row.process_version,
        errorCode: row.error_code,
    });
}
