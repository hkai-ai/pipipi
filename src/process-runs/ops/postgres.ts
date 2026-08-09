import type { Pool, QueryResultRow } from "pg";

export type AsyncReleaseStage = "internal" | "canary" | "production";

export type PostgresAsyncOperationsSnapshot = Readonly<{
    schemaVersion: 1;
    measuredAt: string;
    runs: Readonly<{
        queued: number;
        running: number;
        succeededRecent: number;
        failedRecent: number;
        failureRateRecent: number;
        oldestQueuedAgeMs: number;
        queueWaitP95Ms: number;
        executionP95Ms: number;
        stuck: number;
    }>;
    outbox: Readonly<{
        processPending: number;
        webhookPending: number;
        oldestProcessLagMs: number;
        oldestWebhookLagMs: number;
    }>;
    webhooks: Readonly<{
        pending: number;
        delivering: number;
        succeededRecent: number;
        failedRecent: number;
        exhaustedRecent: number;
        failureRateRecent: number;
        oldestPendingAgeMs: number;
    }>;
    cleanup: Readonly<{
        lastCompletedAt?: string;
        lastDeferredRuns: number;
    }>;
    recovery: Readonly<{
        lastCompletedAt?: string;
        lastStatus?: "completed" | "failed";
        lastMissingJobs: number;
        lastFailedItems: number;
    }>;
    storage: Readonly<{
        databaseBytes: number;
        asyncTablesBytes: number;
    }>;
}>;

export type PostgresAsyncOperations = Readonly<{
    snapshot: (request?: {
        asOf?: string;
    }) => Promise<PostgresAsyncOperationsSnapshot>;
    ready: () => Promise<void>;
}>;

export function createPostgresAsyncOperations(options: {
    pool: Pool;
    recentWindowMs?: number;
    stuckRunAgeMs?: number;
    clock?: () => string;
}): PostgresAsyncOperations {
    const recentWindowMs = positiveInteger(
        options.recentWindowMs ?? 900_000,
        "Async operations recent window",
    );
    const stuckRunAgeMs = positiveInteger(
        options.stuckRunAgeMs ?? 300_000,
        "Async operations stuck Run age",
    );
    const clock = options.clock ?? (() => new Date().toISOString());

    return Object.freeze({
        snapshot: async (request = {}) => {
            const measuredAt = normalizedTimestamp(request.asOf ?? clock());
            const measuredAtMs = new Date(measuredAt).getTime();
            const recentSince = new Date(
                measuredAtMs - recentWindowMs,
            ).toISOString();
            const stuckBefore = new Date(
                measuredAtMs - stuckRunAgeMs,
            ).toISOString();
            const result = await options.pool.query<OperationsRow>(
                operationsQuery,
                [measuredAt, recentSince, stuckBefore],
            );
            const row = result.rows[0];
            if (!row)
                throw new Error("Async operations snapshot is unavailable");

            const succeededRecent = count(
                row.succeeded_recent,
                "recent succeeded Runs",
            );
            const failedRecent = count(row.failed_recent, "recent failed Runs");
            const webhookSucceededRecent = count(
                row.webhook_succeeded_recent,
                "recent succeeded Webhooks",
            );
            const webhookFailedRecent = count(
                row.webhook_failed_recent,
                "recent failed Webhooks",
            );
            const webhookExhaustedRecent = count(
                row.webhook_exhausted_recent,
                "recent exhausted Webhooks",
            );
            const cleanupCompletedAt = optionalTimestamp(
                row.cleanup_completed_at,
            );
            const recoveryCompletedAt = optionalTimestamp(
                row.recovery_completed_at,
            );
            const recoveryStatus = optionalRecoveryStatus(row.recovery_status);

            return Object.freeze({
                schemaVersion: 1 as const,
                measuredAt,
                runs: Object.freeze({
                    queued: count(row.queued_runs, "queued Runs"),
                    running: count(row.running_runs, "running Runs"),
                    succeededRecent,
                    failedRecent,
                    failureRateRecent: rate(
                        failedRecent,
                        succeededRecent + failedRecent,
                    ),
                    oldestQueuedAgeMs: duration(
                        row.oldest_queued_age_ms,
                        "oldest queued Run age",
                    ),
                    queueWaitP95Ms: duration(
                        row.queue_wait_p95_ms,
                        "queue wait p95",
                    ),
                    executionP95Ms: duration(
                        row.execution_p95_ms,
                        "execution p95",
                    ),
                    stuck: count(row.stuck_runs, "stuck Runs"),
                }),
                outbox: Object.freeze({
                    processPending: count(
                        row.process_outbox_pending,
                        "Process Outbox pending",
                    ),
                    webhookPending: count(
                        row.webhook_outbox_pending,
                        "Webhook Outbox pending",
                    ),
                    oldestProcessLagMs: duration(
                        row.oldest_process_outbox_lag_ms,
                        "oldest Process Outbox lag",
                    ),
                    oldestWebhookLagMs: duration(
                        row.oldest_webhook_outbox_lag_ms,
                        "oldest Webhook Outbox lag",
                    ),
                }),
                webhooks: Object.freeze({
                    pending: count(row.webhook_pending, "pending Webhooks"),
                    delivering: count(
                        row.webhook_delivering,
                        "delivering Webhooks",
                    ),
                    succeededRecent: webhookSucceededRecent,
                    failedRecent: webhookFailedRecent,
                    exhaustedRecent: webhookExhaustedRecent,
                    failureRateRecent: rate(
                        webhookFailedRecent + webhookExhaustedRecent,
                        webhookSucceededRecent +
                            webhookFailedRecent +
                            webhookExhaustedRecent,
                    ),
                    oldestPendingAgeMs: duration(
                        row.oldest_webhook_pending_age_ms,
                        "oldest pending Webhook age",
                    ),
                }),
                cleanup: Object.freeze({
                    ...(cleanupCompletedAt
                        ? { lastCompletedAt: cleanupCompletedAt }
                        : {}),
                    lastDeferredRuns: count(
                        row.cleanup_deferred_runs,
                        "deferred cleanup Runs",
                    ),
                }),
                recovery: Object.freeze({
                    ...(recoveryCompletedAt
                        ? { lastCompletedAt: recoveryCompletedAt }
                        : {}),
                    ...(recoveryStatus ? { lastStatus: recoveryStatus } : {}),
                    lastMissingJobs: count(
                        row.recovery_missing_jobs,
                        "recovery missing jobs",
                    ),
                    lastFailedItems: count(
                        row.recovery_failed_items,
                        "recovery failed items",
                    ),
                }),
                storage: Object.freeze({
                    databaseBytes: bytes(row.database_bytes, "database size"),
                    asyncTablesBytes: bytes(
                        row.async_tables_bytes,
                        "async table size",
                    ),
                }),
            });
        },
        ready: async () => {
            const result = await options.pool.query<{
                process_runs: string | null;
                outbox_messages: string | null;
                webhook_deliveries: string | null;
                retention_cleanup_batches: string | null;
                queue_recovery_runs: string | null;
                admission_index: string | null;
            }>(`
        SELECT
          to_regclass('public.process_runs')::text AS process_runs,
          to_regclass('public.outbox_messages')::text AS outbox_messages,
          to_regclass('public.webhook_deliveries')::text AS webhook_deliveries,
          to_regclass('public.retention_cleanup_batches')::text AS retention_cleanup_batches,
          to_regclass('public.queue_recovery_runs')::text AS queue_recovery_runs,
          to_regclass('public.process_runs_caller_backlog_idx')::text AS admission_index
      `);
            const row = result.rows[0];
            if (
                row?.process_runs !== "process_runs" ||
                row.outbox_messages !== "outbox_messages" ||
                row.webhook_deliveries !== "webhook_deliveries" ||
                row.retention_cleanup_batches !== "retention_cleanup_batches" ||
                row.queue_recovery_runs !== "queue_recovery_runs" ||
                row.admission_index !== "process_runs_caller_backlog_idx"
            ) {
                throw new Error(
                    "Async operations database migration is not ready",
                );
            }
        },
    });
}

export function createPostgresAsyncReleaseReadiness(options: {
    pool: Pool;
    stage: AsyncReleaseStage;
    globalBacklogLimit: number;
    stuckRunAgeMs: number;
    maximumStuckRuns: number;
    maximumOutboxLagMs: number;
    recoveryMaxAgeMs: number;
    clock?: () => string;
}): () => Promise<void> {
    const globalBacklogLimit = positiveInteger(
        options.globalBacklogLimit,
        "Async release global backlog limit",
    );
    const stuckRunAgeMs = positiveInteger(
        options.stuckRunAgeMs,
        "Async release stuck Run age",
    );
    const maximumStuckRuns = nonNegativeInteger(
        options.maximumStuckRuns,
        "Async release maximum stuck Runs",
    );
    const maximumOutboxLagMs = positiveInteger(
        options.maximumOutboxLagMs,
        "Async release maximum Outbox lag",
    );
    const recoveryMaxAgeMs = positiveInteger(
        options.recoveryMaxAgeMs,
        "Async release recovery maximum age",
    );
    const clock = options.clock ?? (() => new Date().toISOString());

    if (options.stage === "internal") return async () => {};

    return async () => {
        const asOf = normalizedTimestamp(clock());
        const asOfMs = new Date(asOf).getTime();
        const result = await options.pool.query<ReleaseGateRow>(
            releaseGateQuery,
            [asOf, new Date(asOfMs - stuckRunAgeMs).toISOString()],
        );
        const row = result.rows[0];
        if (!row) throw new Error("Async release readiness is unavailable");
        if (count(row.backlog, "release backlog") >= globalBacklogLimit) {
            throw new Error("Async release capacity gate failed");
        }
        if (count(row.stuck, "release stuck Runs") > maximumStuckRuns) {
            throw new Error("Async release stuck Run gate failed");
        }
        if (
            duration(row.oldest_outbox_lag_ms, "release Outbox lag") >
            maximumOutboxLagMs
        ) {
            throw new Error("Async release Outbox lag gate failed");
        }
        const recoveryCompletedAt = optionalTimestamp(
            row.recovery_completed_at,
        );
        if (
            !recoveryCompletedAt ||
            new Date(recoveryCompletedAt).getTime() <
                asOfMs - recoveryMaxAgeMs ||
            count(row.recovery_failed_count, "release recovery failed items") >
                0 ||
            count(
                row.recovery_incomplete_count,
                "release incomplete recovery batches",
            ) > 0 ||
            row.recovery_finished !== true
        ) {
            throw new Error("Async release recovery gate failed");
        }
    };
}

interface OperationsRow extends QueryResultRow {
    queued_runs: number | string;
    running_runs: number | string;
    succeeded_recent: number | string;
    failed_recent: number | string;
    oldest_queued_age_ms: number | string | null;
    queue_wait_p95_ms: number | string | null;
    execution_p95_ms: number | string | null;
    stuck_runs: number | string;
    process_outbox_pending: number | string;
    webhook_outbox_pending: number | string;
    oldest_process_outbox_lag_ms: number | string | null;
    oldest_webhook_outbox_lag_ms: number | string | null;
    webhook_pending: number | string;
    webhook_delivering: number | string;
    webhook_succeeded_recent: number | string;
    webhook_failed_recent: number | string;
    webhook_exhausted_recent: number | string;
    oldest_webhook_pending_age_ms: number | string | null;
    cleanup_completed_at: Date | string | null;
    cleanup_deferred_runs: number | string | null;
    recovery_completed_at: Date | string | null;
    recovery_status: string | null;
    recovery_missing_jobs: number | string | null;
    recovery_failed_items: number | string | null;
    database_bytes: number | string;
    async_tables_bytes: number | string;
}

interface ReleaseGateRow extends QueryResultRow {
    backlog: number | string;
    stuck: number | string;
    oldest_outbox_lag_ms: number | string | null;
    recovery_completed_at: Date | string | null;
    recovery_failed_count: number | string | null;
    recovery_incomplete_count: number | string | null;
    recovery_finished: boolean | null;
}

const operationsQuery = `
  WITH
    latest_cleanup AS (
      SELECT completed_at, deferred_run_count
      FROM retention_cleanup_batches
      ORDER BY completed_at DESC, cleanup_id DESC
      LIMIT 1
    ),
    latest_recovery AS (
      SELECT completed_at, status, missing_job_count, failed_count
      FROM queue_recovery_runs
      WHERE status IN ('completed', 'failed')
      ORDER BY completed_at DESC, recovery_id DESC
      LIMIT 1
    )
  SELECT
    (SELECT count(*)::integer FROM process_runs WHERE status = 'queued') AS queued_runs,
    (SELECT count(*)::integer FROM process_runs WHERE status = 'running') AS running_runs,
    (SELECT count(*)::integer FROM process_runs WHERE status = 'succeeded' AND finished_at >= $2) AS succeeded_recent,
    (SELECT count(*)::integer FROM process_runs WHERE status = 'failed' AND finished_at >= $2) AS failed_recent,
    COALESCE((
      SELECT greatest(0, extract(epoch FROM ($1::timestamptz - min(created_at))) * 1000)::double precision
      FROM process_runs WHERE status = 'queued'
    ), 0) AS oldest_queued_age_ms,
    COALESCE((
      SELECT percentile_cont(0.95) WITHIN GROUP (
        ORDER BY extract(epoch FROM (started_at - created_at)) * 1000
      )::double precision
      FROM process_runs
      WHERE started_at IS NOT NULL AND created_at >= $2
    ), 0) AS queue_wait_p95_ms,
    COALESCE((
      SELECT percentile_cont(0.95) WITHIN GROUP (
        ORDER BY extract(epoch FROM (finished_at - started_at)) * 1000
      )::double precision
      FROM process_runs
      WHERE finished_at IS NOT NULL AND started_at IS NOT NULL AND finished_at >= $2
    ), 0) AS execution_p95_ms,
    (SELECT count(*)::integer FROM process_runs WHERE
      (status = 'queued' AND updated_at <= $3)
      OR (status = 'running' AND claim_expires_at <= $1)
    ) AS stuck_runs,
    (SELECT count(*)::integer FROM outbox_messages WHERE topic = 'process-runs' AND published_at IS NULL AND available_at <= $1) AS process_outbox_pending,
    (SELECT count(*)::integer FROM outbox_messages WHERE topic = 'webhook-deliveries' AND published_at IS NULL AND available_at <= $1) AS webhook_outbox_pending,
    COALESCE((
      SELECT greatest(0, extract(epoch FROM ($1::timestamptz - min(created_at))) * 1000)::double precision
      FROM outbox_messages WHERE topic = 'process-runs' AND published_at IS NULL AND available_at <= $1
    ), 0) AS oldest_process_outbox_lag_ms,
    COALESCE((
      SELECT greatest(0, extract(epoch FROM ($1::timestamptz - min(created_at))) * 1000)::double precision
      FROM outbox_messages WHERE topic = 'webhook-deliveries' AND published_at IS NULL AND available_at <= $1
    ), 0) AS oldest_webhook_outbox_lag_ms,
    (SELECT count(*)::integer FROM webhook_deliveries WHERE status = 'pending') AS webhook_pending,
    (SELECT count(*)::integer FROM webhook_deliveries WHERE status = 'delivering') AS webhook_delivering,
    (SELECT count(*)::integer FROM webhook_deliveries WHERE status = 'succeeded' AND completed_at >= $2) AS webhook_succeeded_recent,
    (SELECT count(*)::integer FROM webhook_deliveries WHERE status = 'failed' AND completed_at >= $2) AS webhook_failed_recent,
    (SELECT count(*)::integer FROM webhook_deliveries WHERE status = 'exhausted' AND completed_at >= $2) AS webhook_exhausted_recent,
    COALESCE((
      SELECT greatest(0, extract(epoch FROM ($1::timestamptz - min(created_at))) * 1000)::double precision
      FROM webhook_deliveries WHERE status IN ('pending', 'delivering')
    ), 0) AS oldest_webhook_pending_age_ms,
    (SELECT completed_at FROM latest_cleanup) AS cleanup_completed_at,
    COALESCE((SELECT deferred_run_count FROM latest_cleanup), 0) AS cleanup_deferred_runs,
    (SELECT completed_at FROM latest_recovery) AS recovery_completed_at,
    (SELECT status FROM latest_recovery) AS recovery_status,
    COALESCE((SELECT missing_job_count FROM latest_recovery), 0) AS recovery_missing_jobs,
    COALESCE((SELECT failed_count FROM latest_recovery), 0) AS recovery_failed_items,
    pg_database_size(current_database()) AS database_bytes,
    (
      SELECT COALESCE(sum(pg_total_relation_size(relation)), 0)::bigint
      FROM unnest(ARRAY[
        'process_runs'::regclass,
        'process_run_attempts'::regclass,
        'process_events'::regclass,
        'outbox_messages'::regclass,
        'webhook_endpoints'::regclass,
        'webhook_deliveries'::regclass,
        'webhook_delivery_attempts'::regclass,
        'webhook_delivery_replays'::regclass,
        'webhook_endpoint_audit_events'::regclass,
        'retention_cleanup_batches'::regclass,
        'queue_recovery_runs'::regclass,
        'queue_recovery_items'::regclass
      ]) AS relations(relation)
    ) AS async_tables_bytes
`;

const releaseGateQuery = `
  WITH RECURSIVE latest_recovery_root AS (
    SELECT recovery_id
    FROM queue_recovery_runs
    WHERE
      trigger_kind = 'manual'
      AND recovery_mode = 'all'
      AND cursor_run_id IS NULL
    ORDER BY started_at DESC, recovery_id DESC
    LIMIT 1
  ),
  latest_recovery_chain (
    recovery_id,
    actor_id,
    as_of,
    dry_run,
    cursor_run_id,
    next_cursor_run_id,
    status,
    failed_count,
    started_at,
    completed_at
  ) AS (
    SELECT
      recovery.recovery_id,
      recovery.actor_id,
      recovery.as_of,
      recovery.dry_run,
      recovery.cursor_run_id,
      recovery.next_cursor_run_id,
      recovery.status,
      recovery.failed_count,
      recovery.started_at,
      recovery.completed_at
    FROM queue_recovery_runs AS recovery
    JOIN latest_recovery_root AS root
      ON recovery.recovery_id = root.recovery_id
    UNION
    SELECT
      next.recovery_id,
      next.actor_id,
      next.as_of,
      next.dry_run,
      next.cursor_run_id,
      next.next_cursor_run_id,
      next.status,
      next.failed_count,
      next.started_at,
      next.completed_at
    FROM latest_recovery_chain AS current
    JOIN queue_recovery_runs AS next
      ON next.trigger_kind = 'manual'
      AND next.recovery_mode = 'all'
      AND next.actor_id = current.actor_id
      AND next.as_of = current.as_of
      AND next.dry_run = current.dry_run
      AND next.cursor_run_id = current.next_cursor_run_id
    WHERE
      current.status = 'completed'
      AND current.next_cursor_run_id IS NOT NULL
  )
  SELECT
    (SELECT count(*)::integer FROM process_runs WHERE status IN ('queued', 'running')) AS backlog,
    (SELECT count(*)::integer FROM process_runs WHERE
      (status = 'queued' AND updated_at <= $2)
      OR (status = 'running' AND claim_expires_at <= $1)
    ) AS stuck,
    COALESCE((
      SELECT greatest(0, extract(epoch FROM ($1::timestamptz - min(created_at))) * 1000)::double precision
      FROM outbox_messages WHERE published_at IS NULL AND available_at <= $1
    ), 0) AS oldest_outbox_lag_ms,
    (SELECT max(completed_at) FROM latest_recovery_chain) AS recovery_completed_at,
    COALESCE((SELECT sum(failed_count)::bigint FROM latest_recovery_chain), 0) AS recovery_failed_count,
    (SELECT count(*)::integer FROM latest_recovery_chain WHERE status <> 'completed') AS recovery_incomplete_count,
    (
      EXISTS (
        SELECT 1
        FROM latest_recovery_chain
        WHERE status = 'completed' AND next_cursor_run_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM latest_recovery_chain AS current
        WHERE
          current.next_cursor_run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM latest_recovery_chain AS next
            WHERE
              next.actor_id = current.actor_id
              AND next.as_of = current.as_of
              AND next.dry_run = current.dry_run
              AND next.cursor_run_id = current.next_cursor_run_id
          )
      )
    ) AS recovery_finished
`;

function normalizedTimestamp(value: string): string {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time))
        throw new Error("Async operations timestamp is invalid");
    return new Date(time).toISOString();
}

function optionalTimestamp(
    value: Date | string | null | undefined,
): string | undefined {
    return value === null || value === undefined
        ? undefined
        : normalizedTimestamp(
              value instanceof Date ? value.toISOString() : value,
          );
}

function optionalRecoveryStatus(
    value: string | null | undefined,
): "completed" | "failed" | undefined {
    if (value === null || value === undefined) return undefined;
    if (value === "completed" || value === "failed") return value;
    throw new Error("Async operations recovery status is invalid");
}

function count(
    value: number | string | null | undefined,
    label: string,
): number {
    const parsed = Number(value ?? 0);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${label} is outside the supported range`);
    }
    return parsed;
}

function duration(
    value: number | string | null | undefined,
    label: string,
): number {
    const parsed = Number(value ?? 0);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${label} is invalid`);
    }
    return Math.round(parsed);
}

function bytes(value: number | string, label: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${label} is outside the supported range`);
    }
    return parsed;
}

function rate(numerator: number, denominator: number): number {
    return denominator === 0 ? 0 : numerator / denominator;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function nonNegativeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    return value;
}
