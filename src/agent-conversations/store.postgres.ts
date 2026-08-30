/** 用 PostgreSQL 事务持久化 Agent Conversation、Turn、幂等记录与调度 Outbox */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
    AcceptedAgentConversation,
    AcceptedAgentTurn,
    AgentConversationAcceptance,
    AgentConversationCapacity,
    AgentConversationStore,
    ClaimedAgentTurn,
    RecoverableAgentConversationStore,
    StartedAgentTurn,
    StoredAgentConversation,
    StoredAgentConversationMetadata,
    StoredAgentTurn,
} from "./store.js";

export type PostgresAgentConversationStore = RecoverableAgentConversationStore &
    Readonly<{ ready: () => Promise<void> }>;

export function createPostgresAgentConversationStore(options: {
    pool: Pool;
    retentionMs: number;
    claimLeaseMs?: number;
    deletionGraceMs?: number;
    createOutboxMessageId?: () => string;
    createClaimToken?: () => string;
    clock?: () => string;
    admission?: {
        globalBacklogLimit: number;
        callerBacklogLimit: number;
        retryAfterSeconds: number;
    };
}): PostgresAgentConversationStore {
    const retentionMs = positiveInteger(
        options.retentionMs,
        "Agent Conversation retention",
    );
    const createOutboxMessageId = options.createOutboxMessageId ?? randomUUID;
    const claimLeaseMs = positiveInteger(
        options.claimLeaseMs ?? 60_000,
        "Agent Turn claim lease",
    );
    const createClaimToken = options.createClaimToken ?? randomUUID;
    const deletionGraceMs = boundedDeletionGrace(
        options.deletionGraceMs ?? 24 * 60 * 60 * 1_000,
    );
    const clock = options.clock ?? (() => new Date().toISOString());
    const admission = defineAdmission(options.admission);

    return Object.freeze({
        accept: async (candidate) =>
            transaction(options.pool, async (client) => {
                await lockOperation(client, candidate);
                const replay = await replayFor(
                    client,
                    candidate,
                    deletionGraceMs,
                );
                if (replay) return replay;
                const capacity = await capacityFor(
                    client,
                    candidate.ownerId,
                    admission,
                );
                if (capacity) return capacity;

                const expiresAt = addMilliseconds(
                    candidate.createdAt,
                    retentionMs,
                );
                await client.query(
                    `
            INSERT INTO agent_conversations (
              conversation_id,
              owner_id,
              agent_id,
              agent_version,
              config_revision,
              status,
              created_at,
              updated_at,
              expires_at
            )
            VALUES ($1, $2, $3, $4, $5, 'busy', $6, $6, $7)
          `,
                    [
                        candidate.conversationId,
                        candidate.ownerId,
                        candidate.agent.id,
                        candidate.agent.version,
                        candidate.configRevision,
                        candidate.createdAt,
                        expiresAt,
                    ],
                );
                await insertTurn(client, candidate, 1);
                await insertOperation(client, candidate);
                await insertOutbox(
                    client,
                    candidate.turnId,
                    candidate.createdAt,
                    createOutboxMessageId(),
                );
                return createdAcceptance(
                    await loadConversation(client, candidate.conversationId),
                    candidate.turnId,
                );
            }),

        acceptTurn: async (candidate) =>
            transaction(options.pool, async (client) => {
                await lockOperation(client, candidate);
                const replay = await replayFor(
                    client,
                    candidate,
                    deletionGraceMs,
                );
                if (replay) {
                    return replay.outcome === "deleted"
                        ? { outcome: "not_found" }
                        : replay;
                }

                const selected = await client.query<ConversationRow>(
                    `
            SELECT *
            FROM agent_conversations
            WHERE conversation_id = $1
            FOR UPDATE
          `,
                    [candidate.conversationId],
                );
                const conversation = selected.rows[0];
                if (
                    !conversation ||
                    conversation.owner_id !== candidate.ownerId
                ) {
                    return { outcome: "not_found" };
                }
                if (
                    !isActiveConversation(conversation) ||
                    timestampMilliseconds(iso(conversation.expires_at)) <=
                        timestampMilliseconds(candidate.createdAt)
                ) {
                    if (isActiveConversation(conversation)) {
                        await fencePostgresAgentConversation(
                            client,
                            conversation,
                            {
                                status: "expired",
                                timestamp: candidate.createdAt,
                                deleteBy: addMilliseconds(
                                    iso(conversation.expires_at),
                                    deletionGraceMs,
                                ),
                            },
                        );
                    }
                    return { outcome: "not_found" };
                }
                if (conversation.status === "busy") {
                    return { outcome: "busy" };
                }
                const capacity = await capacityFor(
                    client,
                    candidate.ownerId,
                    admission,
                );
                if (capacity) return capacity;
                const latest = await client.query<{
                    turn_id: string;
                    sequence: number;
                }>(
                    `
            SELECT turn_id, sequence
            FROM agent_conversation_turns
            WHERE conversation_id = $1
            ORDER BY sequence DESC
            LIMIT 1
          `,
                    [candidate.conversationId],
                );
                const last = latest.rows[0];
                if (!last || last.turn_id !== candidate.afterTurnId) {
                    return { outcome: "sequence_conflict" };
                }
                if (last.sequence >= candidate.maxTurns) {
                    return { outcome: "turn_limit" };
                }

                const sequence = last.sequence + 1;
                await insertTurn(client, candidate, sequence);
                await insertOperation(client, candidate);
                await insertOutbox(
                    client,
                    candidate.turnId,
                    candidate.createdAt,
                    createOutboxMessageId(),
                );
                await client.query(
                    `
            UPDATE agent_conversations
            SET status = 'busy', updated_at = $2, expires_at = $3
            WHERE conversation_id = $1
          `,
                    [
                        candidate.conversationId,
                        candidate.createdAt,
                        addMilliseconds(candidate.createdAt, retentionMs),
                    ],
                );
                return createdAcceptance(
                    await loadConversation(client, candidate.conversationId),
                    candidate.turnId,
                );
            }),

        findOwnedMetadata: async (conversationId, ownerId) =>
            transaction(options.pool, async (client) => {
                const active = await ensureOwnedActiveConversation(
                    client,
                    conversationId,
                    ownerId,
                    clock(),
                    deletionGraceMs,
                );
                if (!active) return undefined;
                const row = await findMetadata(client, conversationId, ownerId);
                return row ? metadataFromRow(row) : undefined;
            }),

        findOwnedPage: async (request) =>
            transaction(options.pool, async (client) => {
                const active = await ensureOwnedActiveConversation(
                    client,
                    request.conversationId,
                    request.ownerId,
                    clock(),
                    deletionGraceMs,
                );
                if (!active) return undefined;
                const row = await findMetadata(
                    client,
                    request.conversationId,
                    request.ownerId,
                );
                if (!row) return undefined;
                const result = await client.query<TurnRow>(
                    `
          SELECT *
          FROM agent_conversation_turns
          WHERE conversation_id = $1 AND sequence > $2
          ORDER BY sequence
          LIMIT $3
        `,
                    [
                        request.conversationId,
                        request.afterSequence ?? 0,
                        request.limit + 1,
                    ],
                );
                const turns = result.rows
                    .slice(0, request.limit)
                    .map(turnFromRow);
                const last = turns.at(-1);
                return Object.freeze({
                    conversation: metadataFromRow(row),
                    turns: Object.freeze(turns),
                    ...(result.rows.length > turns.length && last
                        ? { nextAfterSequence: last.sequence }
                        : {}),
                });
            }),

        deleteOwned: async (request) =>
            transaction(options.pool, async (client) => {
                assertDeletionWindow(request.requestedAt, request.deleteBy);
                const selected = await client.query<ConversationRow>(
                    `
            SELECT *
            FROM agent_conversations
            WHERE conversation_id = $1
            FOR UPDATE
          `,
                    [request.conversationId],
                );
                const row = selected.rows[0];
                if (!row || row.owner_id !== request.ownerId) {
                    return { outcome: "not_found" };
                }
                if (row.status === "deleting" || row.status === "expired") {
                    if (!row.delete_by) {
                        throw new Error(
                            "Deleted Agent Conversation is inconsistent",
                        );
                    }
                    return {
                        outcome: "replayed",
                        conversationId: row.conversation_id,
                        deleteBy: iso(row.delete_by),
                    };
                }
                await fencePostgresAgentConversation(client, row, {
                    status: "deleting",
                    timestamp: request.requestedAt,
                    deleteBy: request.deleteBy,
                });
                return {
                    outcome: "accepted",
                    conversationId: row.conversation_id,
                    deleteBy: request.deleteBy,
                };
            }),

        start: async (request) =>
            transaction(options.pool, async (client) => {
                const selected = await client.query<TurnWithConversationRow>(
                    `
            SELECT
              turns.*,
              conversations.owner_id,
              conversations.agent_id,
              conversations.agent_version,
              conversations.config_revision,
              conversations.status AS conversation_status,
              conversations.expires_at AS conversation_expires_at
            FROM agent_conversation_turns AS turns
            JOIN agent_conversations AS conversations
              ON conversations.conversation_id = turns.conversation_id
            WHERE turns.turn_id = $1
            FOR UPDATE OF turns, conversations
          `,
                    [request.turnId],
                );
                const row = selected.rows[0];
                if (
                    !row ||
                    !(await ensureTurnConversationActive(
                        client,
                        row,
                        request.startedAt,
                        deletionGraceMs,
                    )) ||
                    row.status !== "queued"
                ) {
                    return undefined;
                }
                const claimToken = createClaimToken();
                await client.query(
                    `
            UPDATE agent_conversation_turns
            SET
              status = 'running',
              started_at = $2,
              claim_token = $3,
              claim_expires_at = $4,
              attempt_count = attempt_count + 1,
              revision = revision + 1
            WHERE turn_id = $1 AND status = 'queued'
          `,
                    [
                        request.turnId,
                        request.startedAt,
                        claimToken,
                        addMilliseconds(request.startedAt, claimLeaseMs),
                    ],
                );
                await insertAttempt(client, {
                    turnId: request.turnId,
                    attemptNumber: Number(row.attempt_count) + 1,
                    claimToken,
                    startedAt: request.startedAt,
                });
                await client.query(
                    `
            UPDATE agent_conversations
            SET updated_at = $2
            WHERE conversation_id = $1
          `,
                    [row.conversation_id, request.startedAt],
                );
                const prior = await client.query<TurnRow>(
                    `
            SELECT *
            FROM agent_conversation_turns
            WHERE conversation_id = $1 AND sequence < $2
            ORDER BY sequence
          `,
                    [row.conversation_id, row.sequence],
                );
                return startedTurnFromRow(row, prior.rows);
            }),

        complete: async (request) =>
            transaction(options.pool, async (client) => {
                const selected = await client.query<TurnWithConversationRow>(
                    `
            SELECT
              turns.*,
              conversations.owner_id,
              conversations.agent_id,
              conversations.agent_version,
              conversations.config_revision,
              conversations.status AS conversation_status,
              conversations.expires_at AS conversation_expires_at
            FROM agent_conversation_turns AS turns
            JOIN agent_conversations AS conversations
              ON conversations.conversation_id = turns.conversation_id
            WHERE turns.turn_id = $1
            FOR UPDATE OF turns, conversations
          `,
                    [request.turnId],
                );
                const row = selected.rows[0];
                if (
                    !row ||
                    !(await ensureTurnConversationActive(
                        client,
                        row,
                        request.completedAt,
                        deletionGraceMs,
                    )) ||
                    row.status !== "running"
                ) {
                    return false;
                }
                await writeTerminalTurn(client, row, request);
                await finishAttempt(client, {
                    turnId: row.turn_id,
                    claimToken: requiredClaimToken(row),
                    finishedAt: request.completedAt,
                    status:
                        request.completion.status === "succeeded"
                            ? "succeeded"
                            : "failed",
                    resultCode:
                        request.completion.status === "failed"
                            ? request.completion.error.code
                            : "SUCCEEDED",
                });
                return true;
            }),

        claim: async (request) =>
            transaction(options.pool, async (client) => {
                const selected = await client.query<TurnWithConversationRow>(
                    `
            SELECT
              turns.*,
              conversations.owner_id,
              conversations.agent_id,
              conversations.agent_version,
              conversations.config_revision,
              conversations.status AS conversation_status,
              conversations.expires_at AS conversation_expires_at
            FROM agent_conversation_turns AS turns
            JOIN agent_conversations AS conversations
              ON conversations.conversation_id = turns.conversation_id
            WHERE turns.turn_id = $1
            FOR UPDATE OF turns, conversations
          `,
                    [request.turnId],
                );
                const row = selected.rows[0];
                if (
                    !row ||
                    !(await ensureTurnConversationActive(
                        client,
                        row,
                        request.claimedAt,
                        deletionGraceMs,
                    )) ||
                    (row.status !== "queued" &&
                        (row.status !== "running" ||
                            !row.claim_expires_at ||
                            new Date(row.claim_expires_at).getTime() >
                                timestampMilliseconds(request.claimedAt)))
                ) {
                    return undefined;
                }
                if (row.status === "running") {
                    await finishAttempt(client, {
                        turnId: row.turn_id,
                        claimToken: requiredClaimToken(row),
                        finishedAt: request.claimedAt,
                        status: "abandoned",
                        resultCode: "CLAIM_EXPIRED",
                    });
                }
                const claimExpiresAt = addMilliseconds(
                    request.claimedAt,
                    claimLeaseMs,
                );
                const updated = await client.query<TurnWithConversationRow>(
                    `
            UPDATE agent_conversation_turns
            SET
              status = 'running',
              claim_token = $2,
              claim_expires_at = $3,
              started_at = COALESCE(started_at, $4),
              attempt_count = attempt_count + 1,
              revision = revision + 1
            WHERE turn_id = $1
            RETURNING *
          `,
                    [
                        request.turnId,
                        request.claimToken,
                        claimExpiresAt,
                        request.claimedAt,
                    ],
                );
                const claimedRow = updated.rows[0];
                if (!claimedRow) throw new Error("Agent Turn claim was lost");
                Object.assign(claimedRow, {
                    owner_id: row.owner_id,
                    agent_id: row.agent_id,
                    agent_version: row.agent_version,
                    config_revision: row.config_revision,
                });
                await insertAttempt(client, {
                    turnId: request.turnId,
                    attemptNumber: Number(claimedRow.attempt_count),
                    claimToken: request.claimToken,
                    startedAt: request.claimedAt,
                });
                await client.query(
                    `
            UPDATE agent_conversations
            SET status = 'busy', updated_at = $2
            WHERE conversation_id = $1
          `,
                    [row.conversation_id, request.claimedAt],
                );
                const prior = await client.query<TurnRow>(
                    `
            SELECT *
            FROM agent_conversation_turns
            WHERE conversation_id = $1 AND sequence < $2
            ORDER BY sequence
          `,
                    [row.conversation_id, row.sequence],
                );
                return claimedTurnFromRow(claimedRow, prior.rows);
            }),

        completeClaim: async (request) =>
            transaction(options.pool, async (client) => {
                const row = await selectClaimedTurn(
                    client,
                    request.turnId,
                    request.claimToken,
                    request.completedAt,
                    deletionGraceMs,
                );
                if (!row) return false;
                await writeTerminalTurn(client, row, request);
                await finishAttempt(client, {
                    turnId: row.turn_id,
                    claimToken: request.claimToken,
                    finishedAt: request.completedAt,
                    status:
                        request.completion.status === "succeeded"
                            ? "succeeded"
                            : "failed",
                    resultCode:
                        request.completion.status === "failed"
                            ? request.completion.error.code
                            : "SUCCEEDED",
                });
                return true;
            }),

        releaseClaim: async (request) =>
            transaction(options.pool, async (client) => {
                const row = await selectClaimedTurn(
                    client,
                    request.turnId,
                    request.claimToken,
                    request.releasedAt,
                    deletionGraceMs,
                );
                if (!row) return false;
                await client.query(
                    `
            UPDATE agent_conversation_turns
            SET
              status = 'queued',
              claim_token = NULL,
              claim_expires_at = NULL,
              revision = revision + 1
            WHERE turn_id = $1 AND claim_token = $2 AND status = 'running'
          `,
                    [request.turnId, request.claimToken],
                );
                await client.query(
                    `
            UPDATE agent_conversations
            SET status = 'busy', updated_at = $2
            WHERE conversation_id = $1
          `,
                    [row.conversation_id, request.releasedAt],
                );
                await finishAttempt(client, {
                    turnId: row.turn_id,
                    claimToken: request.claimToken,
                    finishedAt: request.releasedAt,
                    status: "abandoned",
                    resultCode: "CLAIM_RELEASED",
                });
                return true;
            }),

        findRecoverable: async (request) => {
            const result = await options.pool.query<{
                turn_id: string;
                status: "queued" | "running";
            }>(
                `
          SELECT turns.turn_id, turns.status
          FROM agent_conversation_turns AS turns
          JOIN agent_conversations AS conversations
            ON conversations.conversation_id = turns.conversation_id
          WHERE
            conversations.status IN ('busy', 'ready')
            AND conversations.expires_at > $2
            AND (
              (turns.status = 'queued' AND turns.created_at <= $1)
              OR (turns.status = 'running' AND turns.claim_expires_at <= $2)
            )
          ORDER BY
            CASE
              WHEN turns.status = 'running'
                THEN turns.claim_expires_at
              ELSE turns.created_at
            END,
            turns.turn_id
          LIMIT $3
        `,
                [request.queuedBefore, request.asOf, request.limit],
            );
            return Object.freeze(
                result.rows.map((row) =>
                    Object.freeze({ turnId: row.turn_id, status: row.status }),
                ),
            );
        },

        ready: async () => {
            const result = await options.pool.query<{
                table_name: string | null;
            }>(
                "SELECT to_regclass('public.agent_conversations')::text AS table_name",
            );
            if (result.rows[0]?.table_name !== "agent_conversations") {
                throw new Error(
                    "Agent Conversation PostgreSQL schema is unavailable",
                );
            }
        },
    });
}

interface ConversationRow extends QueryResultRow {
    schema_version: number;
    conversation_id: string;
    owner_id: string;
    agent_id: string;
    agent_version: string;
    config_revision: string;
    status: string;
    working_summary: string | null;
    created_at: Date | string;
    updated_at: Date | string;
    expires_at: Date | string;
    revision: number | string;
    deletion_requested_at: Date | string | null;
    expired_at: Date | string | null;
    delete_by: Date | string | null;
}

interface TurnRow extends QueryResultRow {
    schema_version: number;
    turn_id: string;
    conversation_id: string;
    sequence: number;
    status: string;
    accepted_input: unknown;
    public_output: unknown | null;
    error_code: string | null;
    public_error_message: string | null;
    created_at: Date | string;
    started_at: Date | string | null;
    finished_at: Date | string | null;
    attempt_count: number;
    revision: number | string;
    claim_token: string | null;
    claim_expires_at: Date | string | null;
}

interface TurnWithConversationRow extends TurnRow {
    owner_id: string;
    agent_id: string;
    agent_version: string;
    config_revision: string;
    conversation_status: string;
    conversation_expires_at: Date | string;
}

interface MetadataRow extends ConversationRow {
    turn_count: number;
    last_turn_id: string;
}

interface OperationRow extends QueryResultRow {
    request_fingerprint: string;
    conversation_id: string;
    turn_id: string;
}

async function lockOperation(
    client: PoolClient,
    candidate: { ownerId: string; idempotencyKey: string },
): Promise<void> {
    await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [JSON.stringify([candidate.ownerId, candidate.idempotencyKey])],
    );
}

async function replayFor(
    client: PoolClient,
    candidate: {
        ownerId: string;
        idempotencyKey: string;
        requestFingerprint: string;
        createdAt: string;
    },
    deletionGraceMs: number,
): Promise<AgentConversationAcceptance | undefined> {
    const result = await client.query<OperationRow>(
        `
      SELECT request_fingerprint, conversation_id, turn_id
      FROM agent_conversation_operations
      WHERE owner_id = $1 AND idempotency_key = $2
    `,
        [candidate.ownerId, candidate.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.request_fingerprint !== candidate.requestFingerprint) {
        return { outcome: "conflict" };
    }
    const conversationResult = await client.query<ConversationRow>(
        `
      SELECT *
      FROM agent_conversations
      WHERE conversation_id = $1
      FOR UPDATE
    `,
        [row.conversation_id],
    );
    const persisted = conversationResult.rows[0];
    if (!persisted) {
        throw new Error("Agent Conversation operation is inconsistent");
    }
    if (
        !isActiveConversation(persisted) ||
        timestampMilliseconds(iso(persisted.expires_at)) <=
            timestampMilliseconds(candidate.createdAt)
    ) {
        if (isActiveConversation(persisted)) {
            await fencePostgresAgentConversation(client, persisted, {
                status: "expired",
                timestamp: candidate.createdAt,
                deleteBy: addMilliseconds(
                    iso(persisted.expires_at),
                    deletionGraceMs,
                ),
            });
        }
        return { outcome: "deleted" };
    }
    const conversation = await loadConversation(client, row.conversation_id);
    const turn = conversation.turns.find(
        (candidateTurn) => candidateTurn.turnId === row.turn_id,
    );
    if (!turn) throw new Error("Agent Conversation operation is inconsistent");
    return Object.freeze({
        outcome: "replayed",
        conversation,
        turn,
    });
}

async function insertTurn(
    client: PoolClient,
    candidate: AcceptedAgentConversation | AcceptedAgentTurn,
    sequence: number,
): Promise<void> {
    await client.query(
        `
      INSERT INTO agent_conversation_turns (
        turn_id,
        conversation_id,
        sequence,
        status,
        accepted_input,
        created_at
      )
      VALUES ($1, $2, $3, 'queued', $4::jsonb, $5)
    `,
        [
            candidate.turnId,
            candidate.conversationId,
            sequence,
            serializeJson(candidate.acceptedInput),
            candidate.createdAt,
        ],
    );
}

async function insertOperation(
    client: PoolClient,
    candidate: AcceptedAgentConversation | AcceptedAgentTurn,
): Promise<void> {
    await client.query(
        `
      INSERT INTO agent_conversation_operations (
        owner_id,
        idempotency_key,
        request_fingerprint,
        conversation_id,
        turn_id,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
        [
            candidate.ownerId,
            candidate.idempotencyKey,
            candidate.requestFingerprint,
            candidate.conversationId,
            candidate.turnId,
            candidate.createdAt,
        ],
    );
}

async function insertOutbox(
    client: PoolClient,
    turnId: string,
    createdAt: string,
    messageId: string,
): Promise<void> {
    await client.query(
        `
      INSERT INTO agent_turn_outbox (
        message_id,
        turn_id,
        payload,
        created_at,
        available_at
      )
      VALUES ($1, $2, $3::jsonb, $4, $4)
    `,
        [
            messageId,
            turnId,
            serializeJson({ schemaVersion: 1, turnId }),
            createdAt,
        ],
    );
}

async function insertAttempt(
    client: PoolClient,
    request: {
        turnId: string;
        attemptNumber: number;
        claimToken: string;
        startedAt: string;
    },
): Promise<void> {
    await client.query(
        `
      INSERT INTO agent_turn_attempts (
        turn_id,
        attempt_number,
        claim_token,
        status,
        started_at
      )
      VALUES ($1, $2, $3, 'running', $4)
    `,
        [
            request.turnId,
            request.attemptNumber,
            request.claimToken,
            request.startedAt,
        ],
    );
}

async function finishAttempt(
    client: PoolClient,
    request: {
        turnId: string;
        claimToken: string;
        finishedAt: string;
        status: "succeeded" | "failed" | "abandoned";
        resultCode: string;
    },
): Promise<void> {
    const result = await client.query(
        `
      UPDATE agent_turn_attempts
      SET status = $3, finished_at = $4, result_code = $5
      WHERE turn_id = $1 AND claim_token = $2 AND status = 'running'
    `,
        [
            request.turnId,
            request.claimToken,
            request.status,
            request.finishedAt,
            request.resultCode,
        ],
    );
    if (result.rowCount !== 1) {
        throw new Error("Agent Turn Attempt claim is inconsistent");
    }
}

async function ensureOwnedActiveConversation(
    client: PoolClient,
    conversationId: string,
    ownerId: string,
    asOf: string,
    deletionGraceMs: number,
): Promise<boolean> {
    const selected = await client.query<ConversationRow>(
        `
      SELECT *
      FROM agent_conversations
      WHERE conversation_id = $1 AND owner_id = $2
      FOR UPDATE
    `,
        [conversationId, ownerId],
    );
    const row = selected.rows[0];
    if (!row || !isActiveConversation(row)) return false;
    const expiresAt = iso(row.expires_at);
    if (timestampMilliseconds(expiresAt) > timestampMilliseconds(asOf)) {
        return true;
    }
    await fencePostgresAgentConversation(client, row, {
        status: "expired",
        timestamp: expiresAt,
        deleteBy: addMilliseconds(expiresAt, deletionGraceMs),
    });
    return false;
}

async function ensureTurnConversationActive(
    client: PoolClient,
    row: TurnWithConversationRow,
    asOf: string,
    deletionGraceMs: number,
): Promise<boolean> {
    if (
        row.conversation_status !== "busy" &&
        row.conversation_status !== "ready"
    ) {
        return false;
    }
    const expiresAt = iso(row.conversation_expires_at);
    if (timestampMilliseconds(expiresAt) > timestampMilliseconds(asOf)) {
        return true;
    }
    await fencePostgresAgentConversation(
        client,
        {
            conversation_id: row.conversation_id,
            status: row.conversation_status,
            expires_at: row.conversation_expires_at,
        },
        {
            status: "expired",
            timestamp: expiresAt,
            deleteBy: addMilliseconds(expiresAt, deletionGraceMs),
        },
    );
    return false;
}

export async function fencePostgresAgentConversation(
    client: PoolClient,
    conversation: Readonly<{
        conversation_id: string;
        status: string;
        expires_at: Date | string;
    }>,
    request: Readonly<{
        status: "deleting" | "expired";
        timestamp: string;
        deleteBy: string;
    }>,
): Promise<boolean> {
    if (!isActiveConversation(conversation)) return false;
    timestampMilliseconds(request.timestamp);
    timestampMilliseconds(request.deleteBy);
    await client.query(
        `
      UPDATE agent_turn_attempts AS attempts
      SET
        status = 'abandoned',
        finished_at = GREATEST($2::timestamptz, attempts.started_at),
        result_code = $3
      FROM agent_conversation_turns AS turns
      WHERE
        attempts.turn_id = turns.turn_id
        AND turns.conversation_id = $1
        AND attempts.status = 'running'
    `,
        [
            conversation.conversation_id,
            request.timestamp,
            request.status === "deleting"
                ? "CONVERSATION_DELETED"
                : "CONVERSATION_EXPIRED",
        ],
    );
    await client.query(
        `
      UPDATE agent_conversation_turns
      SET
        status = 'failed',
        public_output = NULL,
        error_code = 'INTERNAL_ERROR',
        public_error_message = 'The Agent Turn is no longer available',
        started_at = COALESCE(started_at, $2),
        finished_at = GREATEST($2::timestamptz, COALESCE(started_at, $2)),
        claim_token = NULL,
        claim_expires_at = NULL,
        revision = revision + 1
      WHERE conversation_id = $1 AND status IN ('queued', 'running')
    `,
        [conversation.conversation_id, request.timestamp],
    );
    await client.query(
        `
      UPDATE agent_tool_invocations
      SET
        status = CASE
          WHEN status = 'executing' AND side_effect = 'priced'
            THEN 'uncertain'
          ELSE 'failed'
        END,
        execution_token = NULL,
        revision = revision + 1,
        public_output = NULL,
        error_code = CASE
          WHEN status = 'executing' AND side_effect = 'priced'
            THEN 'DEPENDENCY_FAILURE_AFTER_COMMIT'
          ELSE 'INTERNAL_ERROR'
        END,
        public_error_message = CASE
          WHEN status = 'executing' AND side_effect = 'priced'
            THEN 'A priced Tool may have completed and will not be retried'
          ELSE 'The Process Tool is no longer available'
        END,
        started_at = COALESCE(started_at, $2),
        finished_at = GREATEST($2::timestamptz, COALESCE(started_at, $2)),
        updated_at = GREATEST(updated_at, $2)
      WHERE conversation_id = $1 AND status IN ('prepared', 'executing')
    `,
        [conversation.conversation_id, request.timestamp],
    );
    await client.query(
        `
      UPDATE agent_turn_outbox
      SET
        claim_token = NULL,
        claim_expires_at = NULL,
        published_at = COALESCE(published_at, $2)
      WHERE turn_id IN (
        SELECT turn_id
        FROM agent_conversation_turns
        WHERE conversation_id = $1
      )
    `,
        [conversation.conversation_id, request.timestamp],
    );
    const updated = await client.query(
        `
      UPDATE agent_conversations
      SET
        status = $2,
        revision = revision + 1,
        deletion_requested_at = CASE
          WHEN $2 = 'deleting' THEN $3::timestamptz
          ELSE NULL
        END,
        expired_at = CASE
          WHEN $2 = 'expired' THEN $3::timestamptz
          ELSE NULL
        END,
        delete_by = $4::timestamptz,
        updated_at = GREATEST(updated_at, $3::timestamptz)
      WHERE conversation_id = $1 AND status IN ('busy', 'ready')
    `,
        [
            conversation.conversation_id,
            request.status,
            request.timestamp,
            request.deleteBy,
        ],
    );
    return updated.rowCount === 1;
}

function isActiveConversation(conversation: { status: string }): boolean {
    return conversation.status === "busy" || conversation.status === "ready";
}

async function selectClaimedTurn(
    client: PoolClient,
    turnId: string,
    claimToken: string,
    asOf: string,
    deletionGraceMs: number,
): Promise<TurnWithConversationRow | undefined> {
    const selected = await client.query<TurnWithConversationRow>(
        `
      SELECT
        turns.*,
        conversations.owner_id,
        conversations.agent_id,
        conversations.agent_version,
        conversations.config_revision,
        conversations.status AS conversation_status,
        conversations.expires_at AS conversation_expires_at
      FROM agent_conversation_turns AS turns
      JOIN agent_conversations AS conversations
        ON conversations.conversation_id = turns.conversation_id
      WHERE turns.turn_id = $1
      FOR UPDATE OF turns, conversations
    `,
        [turnId],
    );
    const row = selected.rows[0];
    if (
        !row ||
        !(await ensureTurnConversationActive(
            client,
            row,
            asOf,
            deletionGraceMs,
        ))
    ) {
        return undefined;
    }
    return row.status === "running" && row.claim_token === claimToken
        ? row
        : undefined;
}

async function writeTerminalTurn(
    client: PoolClient,
    row: TurnRow,
    request: {
        turnId: string;
        completedAt: string;
        completion: Parameters<
            AgentConversationStore["complete"]
        >[0]["completion"];
    },
): Promise<void> {
    if (request.completion.status === "succeeded") {
        await client.query(
            `
        UPDATE agent_conversation_turns
        SET
          status = 'succeeded',
          public_output = $2::jsonb,
          finished_at = $3,
          claim_token = NULL,
          claim_expires_at = NULL,
          revision = revision + 1
        WHERE turn_id = $1 AND status = 'running'
      `,
            [
                request.turnId,
                serializeJson(request.completion.output),
                request.completedAt,
            ],
        );
    } else {
        await client.query(
            `
        UPDATE agent_conversation_turns
        SET
          status = 'failed',
          error_code = $2,
          public_error_message = $3,
          finished_at = $4,
          claim_token = NULL,
          claim_expires_at = NULL,
          revision = revision + 1
        WHERE turn_id = $1 AND status = 'running'
      `,
            [
                request.turnId,
                request.completion.error.code,
                request.completion.error.message,
                request.completedAt,
            ],
        );
    }
    await client.query(
        `
      UPDATE agent_conversations
      SET status = 'ready', updated_at = $2
      WHERE conversation_id = $1
    `,
        [row.conversation_id, request.completedAt],
    );
}

async function findMetadata(
    queryable: Pick<Pool, "query">,
    conversationId: string,
    ownerId: string,
): Promise<MetadataRow | undefined> {
    const result = await queryable.query<MetadataRow>(
        `
      SELECT
        conversations.*,
        count(turns.turn_id)::integer AS turn_count,
        (array_agg(turns.turn_id ORDER BY turns.sequence DESC))[1] AS last_turn_id
      FROM agent_conversations AS conversations
      JOIN agent_conversation_turns AS turns
        ON turns.conversation_id = conversations.conversation_id
      WHERE
        conversations.conversation_id = $1
        AND conversations.owner_id = $2
        AND conversations.status IN ('busy', 'ready')
      GROUP BY conversations.conversation_id
    `,
        [conversationId, ownerId],
    );
    return result.rows[0];
}

async function loadConversation(
    client: PoolClient,
    conversationId: string,
): Promise<StoredAgentConversation> {
    const conversationResult = await client.query<ConversationRow>(
        "SELECT * FROM agent_conversations WHERE conversation_id = $1",
        [conversationId],
    );
    const row = conversationResult.rows[0];
    if (!row) throw new Error("Persisted Agent Conversation is unavailable");
    const turns = await client.query<TurnRow>(
        `
      SELECT *
      FROM agent_conversation_turns
      WHERE conversation_id = $1
      ORDER BY sequence
    `,
        [conversationId],
    );
    return conversationFromRows(row, turns.rows);
}

function createdAcceptance(
    conversation: StoredAgentConversation,
    turnId: string,
): Readonly<{
    outcome: "created";
    conversation: StoredAgentConversation;
    turn: StoredAgentTurn;
}> {
    const turn = conversation.turns.find(
        (candidate) => candidate.turnId === turnId,
    );
    if (!turn) throw new Error("Persisted Agent Turn is unavailable");
    return Object.freeze({ outcome: "created", conversation, turn });
}

function conversationFromRows(
    row: ConversationRow,
    turnRows: readonly TurnRow[],
): StoredAgentConversation {
    assertConversationRow(row);
    return Object.freeze({
        schemaVersion: 1,
        conversationId: row.conversation_id,
        ownerId: row.owner_id,
        agent: Object.freeze({ id: row.agent_id, version: row.agent_version }),
        configRevision: row.config_revision,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        expiresAt: iso(row.expires_at),
        turns: Object.freeze(turnRows.map(turnFromRow)),
    });
}

function metadataFromRow(row: MetadataRow): StoredAgentConversationMetadata {
    assertConversationRow(row);
    const turnCount = safePositiveInteger(row.turn_count, "Agent Turn count");
    if (typeof row.last_turn_id !== "string" || row.last_turn_id.length === 0) {
        throw new Error("Persisted Agent Conversation has no last Turn");
    }
    return Object.freeze({
        schemaVersion: 1,
        conversationId: row.conversation_id,
        ownerId: row.owner_id,
        agent: Object.freeze({ id: row.agent_id, version: row.agent_version }),
        configRevision: row.config_revision,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        expiresAt: iso(row.expires_at),
        turnCount,
        lastTurnId: row.last_turn_id,
        busy: row.status === "busy",
    });
}

function turnFromRow(row: TurnRow): StoredAgentTurn {
    if (Number(row.schema_version) !== 1) {
        throw new Error("Persisted Agent Turn schema is unsupported");
    }
    const base = {
        turnId: row.turn_id,
        sequence: safePositiveInteger(row.sequence, "Agent Turn sequence"),
        input: structuredClone(row.accepted_input) as StoredAgentTurn["input"],
        createdAt: iso(row.created_at),
    };
    switch (row.status) {
        case "queued":
            return Object.freeze({ ...base, status: "queued" });
        case "running":
            if (!row.started_at) throw inconsistentTurn();
            return Object.freeze({
                ...base,
                status: "running",
                startedAt: iso(row.started_at),
            });
        case "succeeded":
            if (!row.started_at || !row.finished_at || !row.public_output) {
                throw inconsistentTurn();
            }
            return Object.freeze({
                ...base,
                status: "succeeded",
                startedAt: iso(row.started_at),
                finishedAt: iso(row.finished_at),
                output: structuredClone(row.public_output) as Extract<
                    StoredAgentTurn,
                    { status: "succeeded" }
                >["output"],
            });
        case "failed":
            if (
                !row.started_at ||
                !row.finished_at ||
                !isAgentTurnErrorCode(row.error_code) ||
                row.public_error_message === null
            ) {
                throw inconsistentTurn();
            }
            return Object.freeze({
                ...base,
                status: "failed",
                startedAt: iso(row.started_at),
                finishedAt: iso(row.finished_at),
                error: Object.freeze({
                    code: row.error_code,
                    message: row.public_error_message,
                }),
            });
        default:
            throw new Error("Persisted Agent Turn status is unsupported");
    }
}

function startedTurnFromRow(
    row: TurnWithConversationRow,
    priorRows: readonly TurnRow[],
): StartedAgentTurn {
    return Object.freeze({
        conversationId: row.conversation_id,
        turnId: row.turn_id,
        ownerId: row.owner_id,
        agent: Object.freeze({ id: row.agent_id, version: row.agent_version }),
        configRevision: row.config_revision,
        input: structuredClone(row.accepted_input) as StartedAgentTurn["input"],
        priorTurns: Object.freeze(priorRows.map(turnFromRow)),
    });
}

function claimedTurnFromRow(
    row: TurnWithConversationRow,
    priorRows: readonly TurnRow[],
): ClaimedAgentTurn {
    if (row.status !== "running" || !row.claim_token || !row.claim_expires_at) {
        throw new Error("Claimed Agent Turn is inconsistent");
    }
    return Object.freeze({
        ...startedTurnFromRow(row, priorRows),
        claimToken: row.claim_token,
        claimExpiresAt: iso(row.claim_expires_at),
        attemptNumber: safePositiveInteger(
            row.attempt_count,
            "Agent Turn attempt count",
        ),
        revision: safePositiveInteger(row.revision, "Agent Turn revision"),
    });
}

function requiredClaimToken(row: TurnRow): string {
    if (!row.claim_token) throw new Error("Agent Turn claim is inconsistent");
    return row.claim_token;
}

function assertConversationRow(row: ConversationRow): void {
    if (Number(row.schema_version) !== 1) {
        throw new Error("Persisted Agent Conversation schema is unsupported");
    }
    if (row.status !== "busy" && row.status !== "ready") {
        throw new Error("Persisted Agent Conversation status is unsupported");
    }
}

function inconsistentTurn(): Error {
    return new Error("Persisted Agent Turn is inconsistent");
}

function isAgentTurnErrorCode(
    value: string | null,
): value is
    | "AGENT_FAILURE"
    | "DEPENDENCY_FAILURE_AFTER_COMMIT"
    | "INTERNAL_ERROR"
    | "INVALID_OUTPUT"
    | "RESOURCE_UNAVAILABLE" {
    return (
        value === "AGENT_FAILURE" ||
        value === "DEPENDENCY_FAILURE_AFTER_COMMIT" ||
        value === "INTERNAL_ERROR" ||
        value === "INVALID_OUTPUT" ||
        value === "RESOURCE_UNAVAILABLE"
    );
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
            // Preserve the transaction's original failure.
        }
        throw error;
    } finally {
        client.release();
    }
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function boundedDeletionGrace(value: number): number {
    const maximum = 24 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(
            "Agent Conversation deletion grace must be between 1 ms and 24 hours",
        );
    }
    return value;
}

type Admission = Readonly<{
    globalBacklogLimit: number;
    callerBacklogLimit: number;
    retryAfterSeconds: number;
}>;

function defineAdmission(
    admission:
        | {
              globalBacklogLimit: number;
              callerBacklogLimit: number;
              retryAfterSeconds: number;
          }
        | undefined,
): Admission | undefined {
    if (!admission) return undefined;
    const globalBacklogLimit = positiveInteger(
        admission.globalBacklogLimit,
        "Global Agent Turn backlog limit",
    );
    const callerBacklogLimit = positiveInteger(
        admission.callerBacklogLimit,
        "Caller Agent Turn backlog limit",
    );
    if (callerBacklogLimit > globalBacklogLimit) {
        throw new Error(
            "Caller Agent Turn backlog limit must not exceed the global limit",
        );
    }
    return Object.freeze({
        globalBacklogLimit,
        callerBacklogLimit,
        retryAfterSeconds: positiveInteger(
            admission.retryAfterSeconds,
            "Agent Turn backlog Retry-After",
        ),
    });
}

async function capacityFor(
    client: PoolClient,
    ownerId: string,
    admission: Admission | undefined,
): Promise<AgentConversationCapacity | undefined> {
    if (!admission) return undefined;
    await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('agent-turn-admission', 0))",
    );
    const result = await client.query<{
        global_count: string;
        caller_count: string;
    }>(
        `
      SELECT
        count(*)::text AS global_count,
        count(*) FILTER (WHERE conversations.owner_id = $1)::text
          AS caller_count
      FROM agent_conversation_turns AS turns
      JOIN agent_conversations AS conversations
        ON conversations.conversation_id = turns.conversation_id
      WHERE
        conversations.status IN ('busy', 'ready')
        AND turns.status IN ('queued', 'running')
    `,
        [ownerId],
    );
    const global = Number(result.rows[0]?.global_count);
    const caller = Number(result.rows[0]?.caller_count);
    if (!Number.isSafeInteger(global) || !Number.isSafeInteger(caller)) {
        throw new Error("Agent Turn backlog count is unavailable");
    }
    return caller >= admission.callerBacklogLimit
        ? Object.freeze({
              outcome: "capacity" as const,
              scope: "caller" as const,
              retryAfterSeconds: admission.retryAfterSeconds,
          })
        : global >= admission.globalBacklogLimit
          ? Object.freeze({
                outcome: "capacity" as const,
                scope: "global" as const,
                retryAfterSeconds: admission.retryAfterSeconds,
            })
          : undefined;
}

function assertDeletionWindow(requestedAt: string, deleteBy: string): void {
    const duration =
        timestampMilliseconds(deleteBy) - timestampMilliseconds(requestedAt);
    if (duration < 0 || duration > 24 * 60 * 60 * 1_000) {
        throw new Error(
            "Agent Conversation deleteBy must be within 24 hours of requestedAt",
        );
    }
}

function safePositiveInteger(value: number | string, label: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${label} is outside the supported range`);
    }
    return parsed;
}

function addMilliseconds(timestamp: string, durationMs: number): string {
    const milliseconds = timestampMilliseconds(timestamp);
    return new Date(milliseconds + durationMs).toISOString();
}

function timestampMilliseconds(timestamp: string): number {
    const milliseconds = new Date(timestamp).getTime();
    if (!Number.isFinite(milliseconds)) {
        throw new Error("Agent Conversation timestamp is invalid");
    }
    return milliseconds;
}

function iso(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new Error("Persisted Agent Conversation timestamp is invalid");
    }
    return date.toISOString();
}

function serializeJson(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new Error("Agent Conversation content must be JSON serializable");
    }
    return serialized;
}
