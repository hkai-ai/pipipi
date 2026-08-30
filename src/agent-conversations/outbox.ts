/** 定义 Agent Turn 最小 Outbox 的 claim、ack 与 release Interface 及 PostgreSQL Adapter */
import type { Pool, QueryResultRow } from "pg";
import { type AgentTurnJob, parseAgentTurnJob } from "./queue.js";

export type ClaimedAgentTurnOutboxMessage = Readonly<{
    messageId: string;
    claimToken: string;
    job: AgentTurnJob;
}>;

export type AgentTurnOutbox = Readonly<{
    claim: (request: {
        limit: number;
        claimToken: string;
        claimedAt: string;
        claimExpiresAt: string;
    }) => Promise<readonly ClaimedAgentTurnOutboxMessage[]>;
    markPublished: (request: {
        messageId: string;
        claimToken: string;
        publishedAt: string;
    }) => Promise<boolean>;
    release: (request: {
        messageId: string;
        claimToken: string;
    }) => Promise<boolean>;
}>;

export function createPostgresAgentTurnOutbox(options: {
    pool: Pool;
}): AgentTurnOutbox {
    return Object.freeze({
        claim: async (request) => {
            assertClaimRequest(request);
            const result = await options.pool.query<AgentTurnOutboxRow>(
                `
          WITH candidates AS (
            SELECT message_id
            FROM agent_turn_outbox
            WHERE
              published_at IS NULL
              AND available_at <= $2
              AND (claim_token IS NULL OR claim_expires_at <= $2)
            ORDER BY available_at, created_at, message_id
            FOR UPDATE SKIP LOCKED
            LIMIT $4
          )
          UPDATE agent_turn_outbox AS messages
          SET
            claim_token = $1,
            claim_expires_at = $3,
            publish_attempt_count = publish_attempt_count + 1
          FROM candidates
          WHERE messages.message_id = candidates.message_id
          RETURNING messages.message_id, messages.claim_token, messages.payload
        `,
                [
                    request.claimToken,
                    request.claimedAt,
                    request.claimExpiresAt,
                    request.limit,
                ],
            );
            return Object.freeze(result.rows.map(claimedMessageFromRow));
        },

        markPublished: async (request) => {
            const result = await options.pool.query(
                `
          UPDATE agent_turn_outbox
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
          UPDATE agent_turn_outbox
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

interface AgentTurnOutboxRow extends QueryResultRow {
    message_id: string;
    claim_token: string;
    payload: unknown;
}

function claimedMessageFromRow(
    row: AgentTurnOutboxRow,
): ClaimedAgentTurnOutboxMessage {
    const job = parseAgentTurnJob(row.payload);
    if (!job) throw new Error("Persisted Agent Turn outbox payload is invalid");
    return Object.freeze({
        messageId: row.message_id,
        claimToken: row.claim_token,
        job,
    });
}

function assertClaimRequest(request: {
    limit: number;
    claimToken: string;
    claimedAt: string;
    claimExpiresAt: string;
}): void {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new Error("Agent Turn outbox claim limit must be positive");
    }
    if (request.limit > 100) {
        throw new Error("Agent Turn outbox claim limit must not exceed 100");
    }
    if (
        typeof request.claimToken !== "string" ||
        request.claimToken.length === 0 ||
        Buffer.byteLength(request.claimToken, "utf8") > 256
    ) {
        throw new Error("Agent Turn outbox claim token is invalid");
    }
    const claimedAt = new Date(request.claimedAt).getTime();
    const expiresAt = new Date(request.claimExpiresAt).getTime();
    if (
        !Number.isFinite(claimedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= claimedAt
    ) {
        throw new Error("Agent Turn outbox claim window is invalid");
    }
}
