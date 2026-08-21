/** 恢复候选的 PostgreSQL Adapter */
import type { Pool, QueryResultRow } from "pg";
import type {
    ProcessRecoveryCandidate,
    ProcessRecoveryStore,
    ProcessRunRecoverySource,
} from "./index.js";

export function createPostgresProcessRunRecoverySource(options: {
    pool: Pool;
}): ProcessRunRecoverySource &
    ProcessRecoveryStore &
    Readonly<{ ready: () => Promise<void> }> {
    return Object.freeze({
        findRecoverable: async (request) => {
            const limit = recoveryLimit(request.limit);
            timestampMilliseconds(request.asOf);
            timestampMilliseconds(request.queuedBefore);
            const result = await options.pool.query<{ run_id: string }>(
                `
          SELECT run_id
          FROM process_runs
          WHERE
            (status = 'queued' AND updated_at <= $1)
            OR (status = 'running' AND claim_expires_at <= $2)
          ORDER BY
            CASE
              WHEN status = 'running' THEN claim_expires_at
              ELSE updated_at
            END,
            run_id
          LIMIT $3
        `,
                [request.queuedBefore, request.asOf, limit],
            );
            return result.rows.map((row) =>
                Object.freeze({ runId: row.run_id }),
            );
        },

        beginRecovery: async (request) => {
            assertUuid(request.recoveryId, "Process Recovery ID");
            assertOwner(request.actorId, "Process Recovery actor");
            timestampMilliseconds(request.asOf);
            timestampMilliseconds(request.queuedBefore);
            timestampMilliseconds(request.startedAt);
            if (request.cursor !== undefined) {
                assertUuid(request.cursor, "Process Recovery cursor");
            }
            await options.pool.query(
                `
          INSERT INTO queue_recovery_runs (
            recovery_id,
            trigger_kind,
            recovery_mode,
            dry_run,
            actor_id,
            as_of,
            queued_before,
            cursor_run_id,
            started_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
                [
                    request.recoveryId,
                    request.trigger,
                    request.mode,
                    request.dryRun,
                    request.actorId,
                    request.asOf,
                    request.queuedBefore,
                    request.cursor ?? null,
                    request.startedAt,
                ],
            );
        },

        findRecoveryCandidates: async (request) => {
            const limit = recoveryLimit(request.limit);
            const asOfMs = timestampMilliseconds(request.asOf);
            const queuedBeforeMs = timestampMilliseconds(request.queuedBefore);
            if (request.cursor !== undefined) {
                assertUuid(request.cursor, "Process Recovery cursor");
            }
            const result = await options.pool.query<RecoveryCandidateRow>(
                `
          SELECT
            runs.run_id,
            runs.status,
            runs.updated_at,
            runs.claim_expires_at,
            EXISTS (
              SELECT 1
              FROM process_events AS events
              JOIN outbox_messages AS messages
                ON messages.event_id = events.event_id
              WHERE
                events.run_id = runs.run_id
                AND messages.topic = 'process-runs'
                AND messages.published_at IS NULL
            ) AS pending_outbox
          FROM process_runs AS runs
          WHERE
            runs.status IN ('queued', 'running')
            AND ($3::uuid IS NULL OR runs.run_id > $3)
            AND (
              $4 = 'all'
              OR (runs.status = 'queued' AND runs.updated_at <= $2)
              OR (
                runs.status = 'running'
                AND runs.claim_expires_at <= $1
              )
            )
          ORDER BY runs.run_id
          LIMIT $5
        `,
                [
                    request.asOf,
                    request.queuedBefore,
                    request.cursor ?? null,
                    request.mode,
                    limit + 1,
                ],
            );
            const hasMore = result.rows.length > limit;
            const selected = result.rows.slice(0, limit);
            const candidates = selected.map((row): ProcessRecoveryCandidate => {
                if (row.status === "queued") {
                    return Object.freeze({
                        runId: row.run_id,
                        status: "queued",
                        reason:
                            row.updated_at.getTime() <= queuedBeforeMs
                                ? "stuck_queued"
                                : "recent_queued",
                        pendingOutbox: row.pending_outbox,
                    });
                }
                if (row.status !== "running" || !row.claim_expires_at) {
                    throw new Error(
                        "Persisted recovery candidate is inconsistent",
                    );
                }
                return Object.freeze({
                    runId: row.run_id,
                    status: "running",
                    reason:
                        row.claim_expires_at.getTime() <= asOfMs
                            ? "expired_lease"
                            : "active_lease",
                    pendingOutbox: row.pending_outbox,
                });
            });
            const last = candidates.at(-1);
            return Object.freeze({
                candidates: Object.freeze(candidates),
                ...(hasMore && last ? { nextCursor: last.runId } : {}),
            });
        },

        acknowledgePendingOutbox: async (request) => {
            assertUuid(request.runId, "Process Run ID");
            timestampMilliseconds(request.acknowledgedAt);
            const result = await options.pool.query(
                `
          UPDATE outbox_messages AS messages
          SET
            published_at = $2,
            claim_token = NULL,
            claim_expires_at = NULL
          FROM process_events AS events
          WHERE
            messages.event_id = events.event_id
            AND events.run_id = $1
            AND messages.topic = 'process-runs'
            AND messages.published_at IS NULL
            AND (
              messages.claim_token IS NULL
              OR messages.claim_expires_at <= $2
            )
        `,
                [request.runId, request.acknowledgedAt],
            );
            return result.rowCount ?? 0;
        },

        recordRecoveryItem: async (request) => {
            assertUuid(request.recoveryId, "Process Recovery ID");
            assertUuid(request.item.runId, "Process Run ID");
            timestampMilliseconds(request.recordedAt);
            await options.pool.query(
                `
          INSERT INTO queue_recovery_items (
            recovery_id,
            run_id,
            run_status,
            reason,
            pending_outbox,
            queue_state,
            action,
            outbox_action,
            recorded_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
                [
                    request.recoveryId,
                    request.item.runId,
                    request.item.status,
                    request.item.reason,
                    request.item.pendingOutbox,
                    request.item.queueState,
                    request.item.action,
                    request.item.outboxAction,
                    request.recordedAt,
                ],
            );
        },

        completeRecovery: async (request) => {
            assertUuid(request.recoveryId, "Process Recovery ID");
            if (request.nextCursor !== undefined) {
                assertUuid(request.nextCursor, "Process Recovery cursor");
            }
            timestampMilliseconds(request.completedAt);
            const counters = request.counters;
            const result = await options.pool.query(
                `
          UPDATE queue_recovery_runs
          SET
            next_cursor_run_id = $2,
            status = 'completed',
            candidate_count = $3,
            missing_job_count = $4,
            existing_job_count = $5,
            terminal_job_count = $6,
            invalid_job_count = $7,
            active_lease_count = $8,
            pending_outbox_count = $9,
            enqueued_count = $10,
            duplicate_count = $11,
            outbox_acknowledged_count = $12,
            failed_count = $13,
            completed_at = $14
          WHERE recovery_id = $1 AND status = 'running'
        `,
                [
                    request.recoveryId,
                    request.nextCursor ?? null,
                    counters.found,
                    counters.missingJobs,
                    counters.existingJobs,
                    counters.terminalJobs,
                    counters.invalidJobs,
                    counters.activeLeases,
                    counters.pendingOutbox,
                    counters.enqueued,
                    counters.duplicates,
                    counters.outboxAcknowledged,
                    counters.failed,
                    request.completedAt,
                ],
            );
            if (result.rowCount !== 1) {
                throw new Error("Process Recovery audit is not running");
            }
        },

        failRecovery: async (request) => {
            assertUuid(request.recoveryId, "Process Recovery ID");
            timestampMilliseconds(request.failedAt);
            await options.pool.query(
                `
          UPDATE queue_recovery_runs
          SET status = 'failed', error_code = $2, completed_at = $3
          WHERE recovery_id = $1 AND status = 'running'
        `,
                [request.recoveryId, request.errorCode, request.failedAt],
            );
        },

        ready: async () => {
            const result = await options.pool.query<{
                runs: string | null;
                recoveryRuns: string | null;
                recoveryItems: string | null;
            }>(`
        SELECT
          to_regclass('public.process_runs')::text AS runs,
          to_regclass('public.queue_recovery_runs')::text AS "recoveryRuns",
          to_regclass('public.queue_recovery_items')::text AS "recoveryItems"
      `);
            if (
                result.rows[0]?.runs !== "process_runs" ||
                result.rows[0]?.recoveryRuns !== "queue_recovery_runs" ||
                result.rows[0]?.recoveryItems !== "queue_recovery_items"
            ) {
                throw new Error(
                    "Process Recovery database migration is not ready",
                );
            }
        },
    });
}

interface RecoveryCandidateRow extends QueryResultRow {
    run_id: string;
    status: string;
    updated_at: Date;
    claim_expires_at: Date | null;
    pending_outbox: boolean;
}

function recoveryLimit(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(
            "Process Run recovery limit must be a positive safe integer",
        );
    }
    if (value > 100) {
        throw new Error("Process Run recovery limit must not exceed 100");
    }
    return value;
}

function timestampMilliseconds(timestamp: string): number {
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time)) {
        throw new Error("Process Run timestamp is invalid");
    }
    return time;
}

function assertUuid(value: string, label: string): void {
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value,
        )
    ) {
        throw new Error(`${label} must be a UUID`);
    }
}

function assertOwner(value: string, label: string): void {
    if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        Buffer.byteLength(value, "utf8") > 512
    ) {
        throw new Error(`${label} must be 1 to 512 UTF-8 bytes`);
    }
}
