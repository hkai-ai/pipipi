/** 分批冻结过期 Agent Conversation，并物理清理到期墓碑及其从属记录 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { fencePostgresAgentConversation } from "./store.postgres.js";

export type AgentConversationCleanupBatchResult = Readonly<{
    cleanupId?: string;
    examined: number;
    expired: number;
    conversationsDeleted: number;
    resourceReferencesDeleted: number;
    nextCursor?: string;
}>;

export type PostgresAgentConversationCleanup = Readonly<{
    cleanupBatch: (request: {
        asOf: string;
        batchSize: number;
        cursor?: string;
    }) => Promise<AgentConversationCleanupBatchResult>;
    ready: () => Promise<void>;
}>;

export function createPostgresAgentConversationCleanup(options: {
    pool: Pool;
    deletionGraceMs?: number;
    createCleanupId?: () => string;
    clock?: () => string;
}): PostgresAgentConversationCleanup {
    const deletionGraceMs = boundedDeletionGrace(
        options.deletionGraceMs ?? 24 * 60 * 60 * 1_000,
    );
    const createCleanupId = options.createCleanupId ?? randomUUID;
    const clock = options.clock ?? (() => new Date().toISOString());

    return Object.freeze({
        cleanupBatch: async (request) => {
            timestampMilliseconds(request.asOf);
            const batchSize = boundedBatchSize(request.batchSize);
            if (request.cursor !== undefined) assertIdentity(request.cursor);

            return transaction(options.pool, async (client) => {
                const candidates = await client.query<CleanupCandidateRow>(
                    candidateQuery("FOR UPDATE SKIP LOCKED"),
                    [request.asOf, request.cursor ?? null, batchSize],
                );
                if (candidates.rows.length === 0) return emptyResult;

                let expired = 0;
                for (const row of candidates.rows) {
                    if (
                        (row.status === "busy" || row.status === "ready") &&
                        timestampMilliseconds(iso(row.expires_at)) <=
                            timestampMilliseconds(request.asOf)
                    ) {
                        const expiresAt = iso(row.expires_at);
                        const fenced = await fencePostgresAgentConversation(
                            client,
                            row,
                            {
                                status: "expired",
                                timestamp: expiresAt,
                                deleteBy: addMilliseconds(
                                    expiresAt,
                                    deletionGraceMs,
                                ),
                            },
                        );
                        if (fenced) expired += 1;
                    }
                }

                const conversationIds = candidates.rows.map(
                    (row) => row.conversation_id,
                );
                const due = await client.query<{ conversation_id: string }>(
                    `
            SELECT conversation_id
            FROM agent_conversations
            WHERE
              conversation_id = ANY($1::text[])
              AND status IN ('deleting', 'expired')
              AND delete_by <= $2
            ORDER BY conversation_id
          `,
                    [conversationIds, request.asOf],
                );
                const dueIds = due.rows.map((row) => row.conversation_id);
                const resourceReferencesDeleted =
                    dueIds.length === 0
                        ? 0
                        : await countAgentOwnedResourceReferences(
                              client,
                              dueIds,
                          );
                const deleted =
                    dueIds.length === 0
                        ? { rowCount: 0 }
                        : await client.query(
                              `
                DELETE FROM agent_conversations
                WHERE conversation_id = ANY($1::text[])
              `,
                              [dueIds],
                          );

                const lastConversationId =
                    candidates.rows.at(-1)?.conversation_id;
                if (!lastConversationId) {
                    throw new Error(
                        "Agent Conversation cleanup candidate is missing",
                    );
                }
                const remaining = await client.query<{ exists: boolean }>(
                    `
            SELECT EXISTS (
              ${candidateQuery("").replace(/;\s*$/, "")}
            ) AS exists
          `,
                    [request.asOf, lastConversationId, 1],
                );
                const hasMore = remaining.rows[0]?.exists === true;
                const cleanupId = createCleanupId();
                assertIdentity(cleanupId);
                const completedAt = clock();
                timestampMilliseconds(completedAt);
                await client.query(
                    `
            INSERT INTO agent_conversation_cleanup_batches (
              cleanup_id,
              as_of,
              cursor_conversation_id,
              next_cursor_conversation_id,
              examined_count,
              expired_count,
              conversation_deleted_count,
              resource_reference_deleted_count,
              completed_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
                    [
                        cleanupId,
                        request.asOf,
                        request.cursor ?? null,
                        hasMore ? lastConversationId : null,
                        candidates.rows.length,
                        expired,
                        deleted.rowCount ?? 0,
                        resourceReferencesDeleted,
                        completedAt,
                    ],
                );
                return Object.freeze({
                    cleanupId,
                    examined: candidates.rows.length,
                    expired,
                    conversationsDeleted: deleted.rowCount ?? 0,
                    resourceReferencesDeleted,
                    ...(hasMore ? { nextCursor: lastConversationId } : {}),
                });
            });
        },

        ready: async () => {
            const result = await options.pool.query<{
                cleanup_batches: string | null;
            }>(`
          SELECT to_regclass('public.agent_conversation_cleanup_batches')::text
            AS cleanup_batches
        `);
            if (
                result.rows[0]?.cleanup_batches !==
                "agent_conversation_cleanup_batches"
            ) {
                throw new Error(
                    "Agent Conversation cleanup database migration is not ready",
                );
            }
        },
    });
}

interface CleanupCandidateRow extends QueryResultRow {
    conversation_id: string;
    status: string;
    expires_at: Date | string;
}

function candidateQuery(lockClause: string): string {
    return `
    SELECT conversation_id, status, expires_at
    FROM agent_conversations
    WHERE
      ($2::text IS NULL OR conversation_id > $2)
      AND (
        (status IN ('busy', 'ready') AND expires_at <= $1)
        OR (status IN ('deleting', 'expired') AND delete_by <= $1)
      )
    ORDER BY conversation_id
    ${lockClause}
    LIMIT $3
  `;
}

async function countAgentOwnedResourceReferences(
    client: PoolClient,
    conversationIds: readonly string[],
): Promise<number> {
    const result = await client.query<{ count: string }>(
        `
      SELECT count(*)::text AS count
      FROM (
        SELECT resource_nodes.value
        FROM agent_conversation_turns AS turns
        CROSS JOIN LATERAL jsonb_path_query(
          turns.public_output,
          'strict $.**.resourceId'
        ) AS resource_nodes(value)
        WHERE turns.conversation_id = ANY($1::text[])
        UNION ALL
        SELECT resource_nodes.value
        FROM agent_tool_invocations AS invocations
        CROSS JOIN LATERAL jsonb_path_query(
          invocations.public_output,
          'strict $.**.resourceId'
        ) AS resource_nodes(value)
        WHERE invocations.conversation_id = ANY($1::text[])
      ) AS resource_references
    `,
        [conversationIds],
    );
    const count = Number(result.rows[0]?.count ?? "0");
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(
            "Agent Conversation resource reference count is invalid",
        );
    }
    return count;
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
    const parsed = positiveInteger(
        value,
        "Agent Conversation cleanup batch size",
    );
    if (parsed > 100) {
        throw new Error(
            "Agent Conversation cleanup batch size must not exceed 100",
        );
    }
    return parsed;
}

function boundedDeletionGrace(value: number): number {
    const parsed = positiveInteger(value, "Agent Conversation deletion grace");
    if (parsed > 24 * 60 * 60 * 1_000) {
        throw new Error(
            "Agent Conversation deletion grace must not exceed 24 hours",
        );
    }
    return parsed;
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
        throw new Error("Agent Conversation cleanup timestamp is invalid");
    }
    return value;
}

function addMilliseconds(timestamp: string, durationMs: number): string {
    return new Date(
        timestampMilliseconds(timestamp) + durationMs,
    ).toISOString();
}

function iso(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new Error(
            "Persisted Agent Conversation cleanup timestamp is invalid",
        );
    }
    return date.toISOString();
}

function assertIdentity(value: string): void {
    if (value.length < 1 || Buffer.byteLength(value, "utf8") > 256) {
        throw new Error(
            "Agent Conversation cleanup identity must be between 1 and 256 bytes",
        );
    }
}

const emptyResult = Object.freeze({
    examined: 0,
    expired: 0,
    conversationsDeleted: 0,
    resourceReferencesDeleted: 0,
});
