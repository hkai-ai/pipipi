import type { Pool, QueryResultRow } from "pg";
import { parseWebhookDeliveryJob } from "./webhook-delivery.js";
import type {
  ClaimedWebhookOutboxMessage,
  WebhookOutbox,
} from "./webhook-outbox.js";

export function createPostgresWebhookOutbox(options: {
  pool: Pool;
}): WebhookOutbox {
  return Object.freeze({
    claimWebhookWork: async (request) => {
      validateLimit(request.limit);
      const result = await options.pool.query<WebhookOutboxRow>(
        `
          WITH candidates AS (
            SELECT message_id
            FROM outbox_messages
            WHERE
              topic = 'webhook-deliveries'
              AND published_at IS NULL
              AND available_at <= $2
              AND (claim_token IS NULL OR claim_expires_at <= $2)
            ORDER BY available_at, created_at, message_id
            FOR UPDATE SKIP LOCKED
            LIMIT $4
          )
          UPDATE outbox_messages AS messages
          SET
            claim_token = $1,
            claim_expires_at = $3,
            publish_attempt_count = publish_attempt_count + 1
          FROM candidates
          WHERE messages.message_id = candidates.message_id
          RETURNING
            messages.message_id,
            messages.event_id,
            messages.claim_token,
            messages.payload
        `,
        [
          request.claimToken,
          request.claimedAt,
          request.claimExpiresAt,
          request.limit,
        ],
      );
      return result.rows.map(claimedMessageFromRow);
    },
    markPublished: async (request) => {
      const result = await options.pool.query(
        `
          UPDATE outbox_messages
          SET
            published_at = $3,
            claim_token = NULL,
            claim_expires_at = NULL
          WHERE
            message_id = $1
            AND claim_token = $2
            AND published_at IS NULL
        `,
        [request.messageId, request.claimToken, request.publishedAt],
      );
      return result.rowCount === 1;
    },
    release: async (request) => {
      const result = await options.pool.query(
        `
          UPDATE outbox_messages
          SET claim_token = NULL, claim_expires_at = NULL
          WHERE
            message_id = $1
            AND claim_token = $2
            AND published_at IS NULL
        `,
        [request.messageId, request.claimToken],
      );
      return result.rowCount === 1;
    },
  });
}

interface WebhookOutboxRow extends QueryResultRow {
  message_id: string;
  event_id: string;
  claim_token: string;
  payload: unknown;
}

function claimedMessageFromRow(
  row: WebhookOutboxRow,
): ClaimedWebhookOutboxMessage {
  const job = parseWebhookDeliveryJob(row.payload);
  if (!job) throw new Error("Persisted Webhook outbox payload is invalid");
  return Object.freeze({
    messageId: row.message_id,
    eventId: row.event_id,
    claimToken: row.claim_token,
    job,
  });
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Webhook outbox claim limit must be a positive integer");
  }
  if (value > 100) {
    throw new Error("Webhook outbox claim limit must not exceed 100");
  }
}
