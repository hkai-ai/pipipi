/** Process Outbox 基于 Postgres 行锁的实现 */
import type { Pool, QueryResultRow } from "pg";
import { parseProcessWorkJob } from "../queue/index.js";
import type { ClaimedProcessOutboxMessage, ProcessOutbox } from "./index.js";

export function createPostgresProcessOutbox(options: {
    pool: Pool;
}): ProcessOutbox {
    return Object.freeze({
        claimProcessWork: async (request) => {
            if (!Number.isInteger(request.limit) || request.limit < 1) {
                throw new Error(
                    "Outbox claim limit must be a positive integer",
                );
            }
            if (request.limit > 100) {
                throw new Error("Outbox claim limit must not exceed 100");
            }

            const result = await options.pool.query<OutboxRow>(
                `
          WITH candidates AS (
            SELECT message_id
            FROM outbox_messages
            WHERE
              topic = 'process-runs'
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

interface OutboxRow extends QueryResultRow {
    message_id: string;
    event_id: string;
    claim_token: string;
    payload: unknown;
}

function claimedMessageFromRow(row: OutboxRow): ClaimedProcessOutboxMessage {
    const job = parseProcessWorkJob(row.payload);
    if (!job)
        throw new Error("Persisted Process Work outbox payload is invalid");
    return {
        messageId: row.message_id,
        eventId: row.event_id,
        claimToken: row.claim_token,
        job,
    };
}
