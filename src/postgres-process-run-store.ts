import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  AcceptedProcessInput,
  ProcessErrorCode,
} from "./process-runtime.js";
import type {
  ClaimedProcessRun,
  ProcessRunStore,
  StoredProcessRun,
} from "./process-run-store.js";

export type PostgresProcessRunStoreRetention = Readonly<{
  acceptedInputMs: number;
  resultMs: number;
  metadataMs: number;
}>;

export type PostgresProcessRunStore = ProcessRunStore &
  Readonly<{
    ready: () => Promise<void>;
  }>;

export function createPostgresProcessRunStore(options: {
  pool: Pool;
  retention: PostgresProcessRunStoreRetention;
  claimLeaseMs?: number;
  createEventId?: () => string;
  createOutboxMessageId?: () => string;
}): PostgresProcessRunStore {
  const retention = validateRetention(options.retention);
  const claimLeaseMs = positiveInteger(
    options.claimLeaseMs ?? 60_000,
    "Process Run claim lease",
  );
  const createEventId = options.createEventId ?? randomUUID;
  const createOutboxMessageId = options.createOutboxMessageId ?? randomUUID;

  return Object.freeze({
    accept: async (candidate) => {
      const acceptedInputJson = serializeJson(candidate.acceptedInput);
      const inputExpiresAt = addMilliseconds(
        candidate.createdAt,
        retention.acceptedInputMs,
      );
      const metadataExpiresAt = addMilliseconds(
        candidate.createdAt,
        retention.metadataMs,
      );

      return transaction(options.pool, async (client) => {
        const inserted = await client.query<ProcessRunRow>(
          `
            INSERT INTO process_runs (
              run_id,
              caller_id,
              idempotency_key,
              request_fingerprint,
              process_id,
              process_version,
              status,
              accepted_input,
              created_at,
              updated_at,
              input_expires_at,
              metadata_expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb, $8, $8, $9, $10)
            ON CONFLICT (caller_id, idempotency_key) DO NOTHING
            RETURNING *
          `,
          [
            candidate.runId,
            candidate.ownerId,
            candidate.idempotencyKey,
            candidate.requestFingerprint,
            candidate.process,
            candidate.version,
            acceptedInputJson,
            candidate.createdAt,
            inputExpiresAt,
            metadataExpiresAt,
          ],
        );

        const row = inserted.rows[0];
        if (!row) {
          const existing = await client.query<ProcessRunRow>(
            `
              SELECT *
              FROM process_runs
              WHERE caller_id = $1 AND idempotency_key = $2
            `,
            [candidate.ownerId, candidate.idempotencyKey],
          );
          const existingRow = existing.rows[0];
          if (!existingRow) {
            throw new Error(
              "Process Run idempotency conflict could not be resolved",
            );
          }
          const existingRun = processRunFromRow(existingRow);
          return existingRun.requestFingerprint === candidate.requestFingerprint
            ? { outcome: "replayed", run: existingRun }
            : { outcome: "conflict" };
        }

        const run = processRunFromRow(row);
        const eventId = createEventId();
        const messageId = createOutboxMessageId();
        const eventPayload = serializeJson({
          schemaVersion: 1,
          eventId,
          type: "process_run.queued",
          createdAt: run.createdAt,
          data: {
            runId: run.runId,
            process: run.process,
            version: run.version,
            status: "queued",
          },
        });
        await client.query(
          `
            INSERT INTO process_events (
              event_id,
              run_id,
              event_type,
              deduplication_key,
              payload,
              created_at
            )
            VALUES ($1, $2, 'process_run.queued', $3, $4::jsonb, $5)
          `,
          [
            eventId,
            run.runId,
            `process-run:${run.runId}:queued:0`,
            eventPayload,
            run.createdAt,
          ],
        );
        await client.query(
          `
            INSERT INTO outbox_messages (
              message_id,
              event_id,
              topic,
              payload,
              created_at,
              available_at
            )
            VALUES ($1, $2, 'process-runs', $3::jsonb, $4, $4)
          `,
          [
            messageId,
            eventId,
            serializeJson({ schemaVersion: 1, runId: run.runId }),
            run.createdAt,
          ],
        );
        return { outcome: "created", run };
      });
    },

    findOwned: async (runId, ownerId) => {
      if (!isUuid(runId)) return undefined;
      const result = await options.pool.query<ProcessRunRow>(
        `
          SELECT *
          FROM process_runs
          WHERE run_id = $1 AND caller_id = $2
        `,
        [runId, ownerId],
      );
      const row = result.rows[0];
      return row ? processRunFromRow(row) : undefined;
    },

    claim: async (request) => {
      if (!isUuid(request.runId) || !isUuid(request.claimToken)) {
        return undefined;
      }
      const claimExpiresAt = addMilliseconds(
        request.claimedAt,
        claimLeaseMs,
      );

      return transaction(options.pool, async (client) => {
        const claimed = await client.query<ProcessRunRow>(
          `
            UPDATE process_runs
            SET
              status = 'running',
              claim_token = $2,
              claim_expires_at = $4,
              started_at = COALESCE(started_at, $3),
              updated_at = $3,
              attempt_count = attempt_count + 1,
              revision = revision + 1
            WHERE run_id = $1 AND status = 'queued'
            RETURNING *
          `,
          [
            request.runId,
            request.claimToken,
            request.claimedAt,
            claimExpiresAt,
          ],
        );
        const row = claimed.rows[0];
        if (!row) return undefined;

        await client.query(
          `
            INSERT INTO process_run_attempts (
              run_id,
              attempt_number,
              claim_token,
              status,
              started_at
            )
            VALUES ($1, $2, $3, 'running', $4)
          `,
          [row.run_id, row.attempt_count, request.claimToken, request.claimedAt],
        );
        return claimedProcessRunFromRow(row);
      });
    },

    complete: async (request) => {
      if (!isUuid(request.runId) || !isUuid(request.claimToken)) return false;
      const completion = request.completion;
      const outputJson =
        completion.status === "succeeded"
          ? serializeJson(completion.output)
          : undefined;
      const errorCode =
        completion.status === "failed" ? completion.error.code : undefined;
      const errorMessage =
        completion.status === "failed" ? completion.error.message : undefined;
      const resultExpiresAt = addMilliseconds(
        request.completedAt,
        retention.resultMs,
      );

      return transaction(options.pool, async (client) => {
        const completed = await client.query<Pick<ProcessRunRow, "attempt_count">>(
          `
            UPDATE process_runs
            SET
              status = $3,
              output = CASE
                WHEN $3 = 'succeeded' THEN $5::jsonb
                ELSE NULL
              END,
              error_code = $6,
              public_error_message = $7,
              claim_token = NULL,
              claim_expires_at = NULL,
              finished_at = $4,
              updated_at = $4,
              result_expires_at = $8,
              revision = revision + 1
            WHERE
              run_id = $1
              AND status = 'running'
              AND claim_token = $2
            RETURNING attempt_count
          `,
          [
            request.runId,
            request.claimToken,
            completion.status,
            request.completedAt,
            outputJson,
            errorCode,
            errorMessage,
            resultExpiresAt,
          ],
        );
        const row = completed.rows[0];
        if (!row) return false;

        const attemptStatus =
          completion.status === "succeeded" ? "succeeded" : "failed";
        const attempt = await client.query(
          `
            UPDATE process_run_attempts
            SET status = $4, finished_at = $5, result_code = $6
            WHERE
              run_id = $1
              AND attempt_number = $2
              AND claim_token = $3
              AND status = 'running'
          `,
          [
            request.runId,
            row.attempt_count,
            request.claimToken,
            attemptStatus,
            request.completedAt,
            completion.status === "succeeded" ? "SUCCEEDED" : errorCode,
          ],
        );
        if (attempt.rowCount !== 1) {
          throw new Error("Process Run Attempt state is inconsistent");
        }
        return true;
      });
    },

    ready: async () => {
      await options.pool.query("SELECT 1");
    },
  });
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
      // Preserve the operation or commit error that made the transaction fail.
    }
    throw error;
  } finally {
    client.release();
  }
}

interface ProcessRunRow extends QueryResultRow {
  schema_version: number;
  run_id: string;
  caller_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  process_id: string;
  process_version: string;
  status: string;
  accepted_input: unknown;
  output: unknown;
  error_code: string | null;
  public_error_message: string | null;
  attempt_count: number;
  revision: string;
  claim_token: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

function processRunFromRow(row: ProcessRunRow): StoredProcessRun {
  if (row.schema_version !== 1) {
    throw new Error("Unsupported persisted Process Run schema version");
  }
  const acceptedInput = row.accepted_input as AcceptedProcessInput;
  const base = {
    schemaVersion: 1 as const,
    runId: row.run_id,
    ownerId: row.caller_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    process: row.process_id,
    version: row.process_version,
    acceptedInput: structuredClone(acceptedInput),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    attemptCount: row.attempt_count,
    revision: safeInteger(row.revision, "Process Run revision"),
  };

  switch (row.status) {
    case "queued":
      return { ...base, status: "queued" };
    case "running":
      if (!row.claim_token || !row.started_at) {
        throw new Error("Persisted running Process Run is inconsistent");
      }
      return {
        ...base,
        status: "running",
        claimToken: row.claim_token,
        startedAt: iso(row.started_at),
      };
    case "succeeded":
      if (!row.started_at || !row.finished_at) {
        throw new Error("Persisted succeeded Process Run is inconsistent");
      }
      return {
        ...base,
        status: "succeeded",
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        output: structuredClone(row.output),
      };
    case "failed":
      if (
        !row.started_at ||
        !row.finished_at ||
        !isProcessErrorCode(row.error_code) ||
        row.public_error_message === null
      ) {
        throw new Error("Persisted failed Process Run is inconsistent");
      }
      return {
        ...base,
        status: "failed",
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        error: {
          code: row.error_code,
          message: row.public_error_message,
        },
      };
    default:
      throw new Error("Persisted Process Run status is unsupported");
  }
}

function claimedProcessRunFromRow(row: ProcessRunRow): ClaimedProcessRun {
  const run = processRunFromRow(row);
  if (run.status !== "running") {
    throw new Error("Claimed Process Run is not running");
  }
  return {
    runId: run.runId,
    process: run.process,
    version: run.version,
    acceptedInput: structuredClone(run.acceptedInput),
    claimToken: run.claimToken,
  };
}

function validateRetention(
  retention: PostgresProcessRunStoreRetention,
): PostgresProcessRunStoreRetention {
  return Object.freeze({
    acceptedInputMs: positiveInteger(
      retention.acceptedInputMs,
      "Accepted Process input retention",
    ),
    resultMs: positiveInteger(retention.resultMs, "Process result retention"),
    metadataMs: positiveInteger(
      retention.metadataMs,
      "Process metadata retention",
    ),
  });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function addMilliseconds(timestamp: string, durationMs: number): string {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) throw new Error("Process Run timestamp is invalid");
  return new Date(time + durationMs).toISOString();
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Process Run content must be JSON serializable");
  }
  return serialized;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Persisted Process Run timestamp is invalid");
  }
  return date.toISOString();
}

function safeInteger(value: string | number, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is outside the supported range`);
  }
  return number;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

const processErrorCodes = new Set<ProcessErrorCode>([
  "AGENT_FAILURE",
  "DEPENDENCY_FAILURE",
  "INTERNAL_ERROR",
  "INVALID_INPUT",
  "INVALID_OUTPUT",
  "PROCESS_NOT_FOUND",
  "PROCESS_TIMEOUT",
]);

function isProcessErrorCode(value: string | null): value is ProcessErrorCode {
  return value !== null && processErrorCodes.has(value as ProcessErrorCode);
}
