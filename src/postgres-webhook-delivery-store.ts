import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  assertStandardWebhookSecret,
  assertWebhookEndpointUrl,
  type ClaimedWebhookDelivery,
  type WebhookDeliveryStore,
} from "./webhook-delivery.js";

export type WebhookEndpointView = Readonly<{
  endpointId: string;
  ownerId: string;
  url: string;
  status: "enabled" | "disabled";
  createdAt: string;
  updatedAt: string;
}>;

export type WebhookDeliveryView = Readonly<{
  deliveryId: string;
  eventId: string;
  endpointId: string;
  runId: string;
  eventType: "process_run.succeeded" | "process_run.failed";
  status: "pending" | "delivering" | "succeeded" | "failed" | "exhausted";
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  lastHttpStatus?: number;
  lastErrorCode?: string;
}>;

export type PostgresWebhookDeliveryStore = WebhookDeliveryStore &
  Readonly<{
    provisionEndpoint: (candidate: {
      endpointId: string;
      ownerId: string;
      url: string;
      secret: string;
      createdAt: string;
      allowInsecureHttp?: boolean;
    }) => Promise<WebhookEndpointView>;
    findByRun: (request: {
      ownerId: string;
      runIds: readonly string[];
    }) => Promise<readonly WebhookDeliveryView[]>;
    ready: () => Promise<void>;
  }>;

export function createPostgresWebhookDeliveryStore(options: {
  pool: Pool;
  claimLeaseMs?: number;
}): PostgresWebhookDeliveryStore {
  const claimLeaseMs = positiveInteger(
    options.claimLeaseMs ?? 30_000,
    "Webhook Delivery claim lease",
  );

  return Object.freeze({
    provisionEndpoint: async (candidate) => {
      assertUuid(candidate.endpointId, "Webhook Endpoint ID");
      assertOwner(candidate.ownerId);
      assertWebhookEndpointUrl(candidate.url, {
        allowInsecureHttp: candidate.allowInsecureHttp,
      });
      assertStandardWebhookSecret(candidate.secret);
      timestampMilliseconds(candidate.createdAt);
      const result = await options.pool.query<EndpointRow>(
        `
          INSERT INTO webhook_endpoints (
            endpoint_id,
            caller_id,
            url,
            current_secret,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $5)
          RETURNING *
        `,
        [
          candidate.endpointId,
          candidate.ownerId,
          candidate.url,
          candidate.secret,
          candidate.createdAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Webhook Endpoint was not persisted");
      return endpointFromRow(row);
    },

    claim: async (request): Promise<ClaimedWebhookDelivery | undefined> => {
      if (!isUuid(request.deliveryId) || !isUuid(request.claimToken)) {
        return undefined;
      }
      const claimExpiresAt = addMilliseconds(request.claimedAt, claimLeaseMs);
      const result = await options.pool.query<ClaimedDeliveryRow>(
        `
          UPDATE webhook_deliveries AS deliveries
          SET
            status = 'delivering',
            attempt_count = deliveries.attempt_count + 1,
            claim_token = $2,
            claim_expires_at = $4,
            updated_at = $3
          FROM webhook_endpoints AS endpoints
          WHERE
            deliveries.delivery_id = $1
            AND deliveries.endpoint_id = endpoints.endpoint_id
            AND deliveries.status = 'pending'
            AND deliveries.next_attempt_at <= $3
            AND endpoints.status = 'enabled'
          RETURNING
            deliveries.delivery_id,
            deliveries.event_id,
            deliveries.endpoint_id,
            deliveries.payload,
            deliveries.claim_token,
            deliveries.attempt_count,
            endpoints.url,
            endpoints.current_secret,
            CASE
              WHEN endpoints.previous_secret_valid_until >= $3
              THEN endpoints.previous_secret
              ELSE NULL
            END AS previous_secret
        `,
        [
          request.deliveryId,
          request.claimToken,
          request.claimedAt,
          claimExpiresAt,
        ],
      );
      const row = result.rows[0];
      return row ? claimedDeliveryFromRow(row) : undefined;
    },

    complete: async (request) => {
      if (!isUuid(request.deliveryId) || !isUuid(request.claimToken)) {
        return false;
      }
      timestampMilliseconds(request.completedAt);
      validateSendResult(request.result);

      return transaction(options.pool, async (client) => {
        const selected = await client.query<DeliveryRow>(
          `
            SELECT *
            FROM webhook_deliveries
            WHERE delivery_id = $1
            FOR UPDATE
          `,
          [request.deliveryId],
        );
        const delivery = selected.rows[0];
        if (
          !delivery ||
          delivery.status !== "delivering" ||
          delivery.claim_token !== request.claimToken
        ) {
          return false;
        }
        const httpStatus = request.result.httpStatus ?? null;
        const errorCode =
          request.result.outcome === "failed" ? request.result.errorCode : null;
        const nextStatus =
          request.result.outcome === "succeeded" ? "succeeded" : "failed";
        const updated = await client.query(
          `
            UPDATE webhook_deliveries
            SET
              status = $3,
              claim_token = NULL,
              claim_expires_at = NULL,
              last_http_status = $5,
              last_error_code = $6,
              updated_at = $4,
              completed_at = $4
            WHERE
              delivery_id = $1
              AND claim_token = $2
              AND status = 'delivering'
          `,
          [
            request.deliveryId,
            request.claimToken,
            nextStatus,
            request.completedAt,
            httpStatus,
            errorCode,
          ],
        );
        if (updated.rowCount !== 1) return false;
        await client.query(
          `
            INSERT INTO webhook_delivery_attempts (
              delivery_id,
              attempt_number,
              started_at,
              finished_at,
              outcome,
              http_status,
              latency_ms,
              error_code
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            request.deliveryId,
            delivery.attempt_count,
            delivery.updated_at,
            request.completedAt,
            request.result.outcome,
            httpStatus,
            request.result.latencyMs,
            errorCode,
          ],
        );
        return true;
      });
    },

    findByRun: async (request) => {
      assertOwner(request.ownerId);
      if (request.runIds.length > 100) {
        throw new Error("Webhook Delivery lookup must not exceed 100 Run IDs");
      }
      if (request.runIds.some((runId) => !isUuid(runId))) return [];
      if (request.runIds.length === 0) return [];
      const result = await options.pool.query<DeliveryRow>(
        `
          SELECT *
          FROM webhook_deliveries
          WHERE caller_id = $1 AND run_id = ANY($2::uuid[])
          ORDER BY created_at, delivery_id
        `,
        [request.ownerId, request.runIds],
      );
      return result.rows.map(deliveryFromRow);
    },

    ready: async () => {
      const result = await options.pool.query<{
        endpoints: string | null;
        deliveries: string | null;
      }>(`
        SELECT
          to_regclass('public.webhook_endpoints')::text AS endpoints,
          to_regclass('public.webhook_deliveries')::text AS deliveries
      `);
      if (
        result.rows[0]?.endpoints !== "webhook_endpoints" ||
        result.rows[0]?.deliveries !== "webhook_deliveries"
      ) {
        throw new Error("Webhook Delivery database migration is not ready");
      }
    },
  });
}

interface EndpointRow extends QueryResultRow {
  endpoint_id: string;
  caller_id: string;
  url: string;
  status: "enabled" | "disabled";
  created_at: Date;
  updated_at: Date;
}

interface DeliveryRow extends QueryResultRow {
  delivery_id: string;
  event_id: string;
  endpoint_id: string;
  run_id: string;
  caller_id: string;
  event_type: "process_run.succeeded" | "process_run.failed";
  payload: string;
  status: "pending" | "delivering" | "succeeded" | "failed" | "exhausted";
  attempt_count: number;
  claim_token: string | null;
  updated_at: Date;
  created_at: Date;
  completed_at: Date | null;
  last_http_status: number | null;
  last_error_code: string | null;
}

interface ClaimedDeliveryRow extends QueryResultRow {
  delivery_id: string;
  event_id: string;
  endpoint_id: string;
  payload: string;
  claim_token: string;
  attempt_count: number;
  url: string;
  current_secret: string;
  previous_secret: string | null;
}

function endpointFromRow(row: EndpointRow): WebhookEndpointView {
  return Object.freeze({
    endpointId: row.endpoint_id,
    ownerId: row.caller_id,
    url: row.url,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function deliveryFromRow(row: DeliveryRow): WebhookDeliveryView {
  return Object.freeze({
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    runId: row.run_id,
    eventType: row.event_type,
    status: row.status,
    attemptCount: row.attempt_count,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    ...(row.last_http_status === null
      ? {}
      : { lastHttpStatus: row.last_http_status }),
    ...(row.last_error_code === null
      ? {}
      : { lastErrorCode: row.last_error_code }),
  });
}

function claimedDeliveryFromRow(row: ClaimedDeliveryRow): ClaimedWebhookDelivery {
  return Object.freeze({
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    endpointUrl: row.url,
    secrets: Object.freeze([
      row.current_secret,
      ...(row.previous_secret ? [row.previous_secret] : []),
    ]),
    payload: row.payload,
    claimToken: row.claim_token,
    attemptNumber: row.attempt_count,
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
      // Preserve the original operation or commit error.
    }
    throw error;
  } finally {
    client.release();
  }
}

function validateSendResult(
  result: Parameters<WebhookDeliveryStore["complete"]>[0]["result"],
): void {
  if (!Number.isSafeInteger(result.latencyMs) || result.latencyMs < 0) {
    throw new Error("Webhook Delivery latency is invalid");
  }
  if (
    result.httpStatus !== undefined &&
    (!Number.isInteger(result.httpStatus) ||
      result.httpStatus < 100 ||
      result.httpStatus > 599)
  ) {
    throw new Error("Webhook Delivery HTTP status is invalid");
  }
}

function assertOwner(value: string): void {
  const length = Buffer.byteLength(value, "utf8");
  if (length < 1 || length > 512) {
    throw new Error("Webhook owner is invalid");
  }
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) throw new Error(`${label} must be a UUID`);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function addMilliseconds(timestamp: string, durationMs: number): string {
  return new Date(timestampMilliseconds(timestamp) + durationMs).toISOString();
}

function timestampMilliseconds(timestamp: string): number {
  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) throw new Error("Webhook timestamp is invalid");
  return value;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Persisted Webhook timestamp is invalid");
  }
  return date.toISOString();
}
