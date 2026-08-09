import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

export type RetentionCleanupBatchResult = Readonly<{
  cleanupId?: string;
  examined: number;
  inputContentsDeleted: number;
  resultsDeleted: number;
  deliveryAttemptsDeleted: number;
  runsDeleted: number;
  deferredRuns: number;
  nextCursor?: string;
}>;

export type PostgresRetentionCleanup = Readonly<{
  cleanupBatch: (request: {
    asOf: string;
    batchSize: number;
    cursor?: string;
  }) => Promise<RetentionCleanupBatchResult>;
  ready: () => Promise<void>;
}>;

export function createPostgresRetentionCleanup(options: {
  pool: Pool;
  webhookDeliveryHistoryMs: number;
  createCleanupId?: () => string;
  clock?: () => string;
}): PostgresRetentionCleanup {
  const webhookDeliveryHistoryMs = positiveInteger(
    options.webhookDeliveryHistoryMs,
    "Webhook Delivery history retention",
  );
  const createCleanupId = options.createCleanupId ?? randomUUID;
  const clock = options.clock ?? (() => new Date().toISOString());

  return Object.freeze({
    cleanupBatch: async (request) => {
      const asOfMs = timestampMilliseconds(request.asOf);
      const batchSize = boundedBatchSize(request.batchSize);
      if (request.cursor !== undefined && !isUuid(request.cursor)) {
        throw new Error("Retention cleanup cursor must be a UUID");
      }
      const deliveryCutoff = new Date(
        asOfMs - webhookDeliveryHistoryMs,
      ).toISOString();

      return transaction(options.pool, async (client) => {
        const candidates = await client.query<{ run_id: string }>(
          candidateQuery("FOR UPDATE OF runs"),
          [
            request.asOf,
            deliveryCutoff,
            request.cursor ?? null,
            batchSize,
          ],
        );
        const runIds = candidates.rows.map((row) => row.run_id);
        if (runIds.length === 0) return emptyResult;

        const input = await client.query(
          `
            UPDATE process_runs
            SET
              accepted_input = NULL,
              input_expired_at = $2,
              revision = revision + 1
            WHERE
              run_id = ANY($1::uuid[])
              AND status IN ('succeeded', 'failed')
              AND accepted_input IS NOT NULL
              AND input_expires_at <= $2
          `,
          [runIds, request.asOf],
        );
        const results = await client.query(
          `
            UPDATE process_runs
            SET
              output = NULL,
              error_code = NULL,
              public_error_message = NULL,
              result_expired_at = $2,
              revision = revision + 1
            WHERE
              run_id = ANY($1::uuid[])
              AND status IN ('succeeded', 'failed')
              AND result_expired_at IS NULL
              AND result_expires_at <= $2
          `,
          [runIds, request.asOf],
        );
        const deliveryAttempts = await client.query(
          `
            DELETE FROM webhook_delivery_attempts AS attempts
            USING webhook_deliveries AS deliveries
            WHERE
              attempts.delivery_id = deliveries.delivery_id
              AND deliveries.run_id = ANY($1::uuid[])
              AND attempts.finished_at IS NOT NULL
              AND attempts.finished_at <= $2
          `,
          [runIds, deliveryCutoff],
        );

        const metadataDue = await client.query<{ count: string }>(
          `
            SELECT count(*)::text AS count
            FROM process_runs
            WHERE
              run_id = ANY($1::uuid[])
              AND metadata_expires_at <= $2
          `,
          [runIds, request.asOf],
        );
        const deleted = await client.query<{ run_id: string }>(
          `
            DELETE FROM process_runs AS runs
            WHERE
              runs.run_id = ANY($1::uuid[])
              AND runs.status IN ('succeeded', 'failed')
              AND runs.metadata_expires_at <= $2
              AND runs.input_expires_at <= $2
              AND runs.result_expires_at <= $2
              AND NOT EXISTS (
                SELECT 1
                FROM webhook_deliveries AS deliveries
                WHERE
                  deliveries.run_id = runs.run_id
                  AND (
                    deliveries.status NOT IN ('succeeded', 'failed', 'exhausted')
                    OR deliveries.completed_at IS NULL
                    OR deliveries.completed_at > $3
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM outbox_messages AS messages
                JOIN process_events AS events
                  ON events.event_id = messages.event_id
                WHERE
                  events.run_id = runs.run_id
                  AND messages.topic = 'webhook-deliveries'
                  AND messages.published_at IS NULL
              )
            RETURNING runs.run_id
          `,
          [runIds, request.asOf, deliveryCutoff],
        );

        const lastRunId = runIds.at(-1);
        if (!lastRunId) throw new Error("Retention cleanup candidate is missing");
        const remaining = await client.query<{ exists: boolean }>(
          `
            SELECT EXISTS (
              ${candidateQuery("").replace(/;\s*$/, "")}
            ) AS exists
          `,
          [request.asOf, deliveryCutoff, lastRunId, 1],
        );
        const hasMore = remaining.rows[0]?.exists === true;
        const cleanupId = createCleanupId();
        const completedAt = clock();
        timestampMilliseconds(completedAt);
        const metadataDueCount = Number(metadataDue.rows[0]?.count ?? "0");
        const deferredRuns = metadataDueCount - (deleted.rowCount ?? 0);
        await client.query(
          `
            INSERT INTO retention_cleanup_batches (
              cleanup_id,
              as_of,
              cursor_run_id,
              next_cursor_run_id,
              examined_count,
              input_deleted_count,
              result_deleted_count,
              delivery_attempt_deleted_count,
              run_deleted_count,
              deferred_run_count,
              completed_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `,
          [
            cleanupId,
            request.asOf,
            request.cursor ?? null,
            hasMore ? lastRunId : null,
            runIds.length,
            input.rowCount ?? 0,
            results.rowCount ?? 0,
            deliveryAttempts.rowCount ?? 0,
            deleted.rowCount ?? 0,
            deferredRuns,
            completedAt,
          ],
        );
        return Object.freeze({
          cleanupId,
          examined: runIds.length,
          inputContentsDeleted: input.rowCount ?? 0,
          resultsDeleted: results.rowCount ?? 0,
          deliveryAttemptsDeleted: deliveryAttempts.rowCount ?? 0,
          runsDeleted: deleted.rowCount ?? 0,
          deferredRuns,
          ...(hasMore ? { nextCursor: lastRunId } : {}),
        });
      });
    },

    ready: async () => {
      const result = await options.pool.query<{ cleanup_batches: string | null }>(
        `
          SELECT to_regclass('public.retention_cleanup_batches')::text
            AS cleanup_batches
        `,
      );
      if (result.rows[0]?.cleanup_batches !== "retention_cleanup_batches") {
        throw new Error("Retention cleanup database migration is not ready");
      }
    },
  });
}

function candidateQuery(lockClause: string): string {
  return `
    SELECT runs.run_id
    FROM process_runs AS runs
    WHERE
      runs.status IN ('succeeded', 'failed')
      AND ($3::uuid IS NULL OR runs.run_id > $3)
      AND (
        (runs.accepted_input IS NOT NULL AND runs.input_expires_at <= $1)
        OR (
          runs.result_expired_at IS NULL
          AND runs.result_expires_at <= $1
        )
        OR runs.metadata_expires_at <= $1
        OR EXISTS (
          SELECT 1
          FROM webhook_deliveries AS deliveries
          JOIN webhook_delivery_attempts AS attempts
            ON attempts.delivery_id = deliveries.delivery_id
          WHERE
            deliveries.run_id = runs.run_id
            AND attempts.finished_at IS NOT NULL
            AND attempts.finished_at <= $2
        )
      )
    ORDER BY runs.run_id
    ${lockClause}
    LIMIT $4
  `;
}

async function transaction<Result>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the cleanup or commit error.
    }
    throw error;
  } finally {
    client.release();
  }
}

function boundedBatchSize(value: number): number {
  const batchSize = positiveInteger(value, "Retention cleanup batch size");
  if (batchSize > 100) {
    throw new Error("Retention cleanup batch size must not exceed 100");
  }
  return batchSize;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function timestampMilliseconds(timestamp: string): number {
  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) {
    throw new Error("Retention cleanup timestamp is invalid");
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

const emptyResult = Object.freeze({
  examined: 0,
  inputContentsDeleted: 0,
  resultsDeleted: 0,
  deliveryAttemptsDeleted: 0,
  runsDeleted: 0,
  deferredRuns: 0,
});
