import type { Pool } from "pg";
import type {
    ProcessErrorCode,
    ProcessRunLogRecord,
} from "../process-runtime/index.js";
import type { ProcessRunRecord } from "../process-runtime/records.js";
import type { ProcessRunActivityArchive } from "./process-run-activities.js";
import {
    defaultProcessRunRecordListLimit,
    maximumProcessRunRecordListLimit,
    type ProcessRunRecordArchive,
    redactProcessRunRecord,
} from "./process-run-records.js";

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
            const limit = parseListLimit(query.limit);
            const { rows } = await pool.query(
                `${recordSelect}
                 where ($1::timestamptz is null or recorded_at < $1::timestamptz)
                 order by recorded_at desc, run_id desc
                 limit $2`,
                [query.before ?? null, limit + 1],
            );
            const records = rows.slice(0, limit).map(toRecord);
            return Object.freeze(
                rows.length > limit
                    ? {
                          records: Object.freeze(records),
                          nextBefore: records.at(-1)?.recordedAt,
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

    return Object.freeze({
        record: (record) => {
            void pool
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
                .catch(() => {});
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

function parseListLimit(value: number | undefined): number {
    if (value === undefined) return defaultProcessRunRecordListLimit;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("Run Record list limit must be a positive integer");
    }
    return Math.min(value, maximumProcessRunRecordListLimit);
}
