/** 用 PostgreSQL 事务持久化 Agent Conversation、Turn、幂等记录与调度 Outbox */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
    AcceptedAgentConversation,
    AcceptedAgentTurn,
    AgentConversationAcceptance,
    AgentConversationStore,
    StartedAgentTurn,
    StoredAgentConversation,
    StoredAgentConversationMetadata,
    StoredAgentTurn,
} from "./store.js";

export type PostgresAgentConversationStore = AgentConversationStore &
    Readonly<{ ready: () => Promise<void> }>;

export function createPostgresAgentConversationStore(options: {
    pool: Pool;
    retentionMs: number;
    createOutboxMessageId?: () => string;
}): PostgresAgentConversationStore {
    const retentionMs = positiveInteger(
        options.retentionMs,
        "Agent Conversation retention",
    );
    const createOutboxMessageId = options.createOutboxMessageId ?? randomUUID;

    return Object.freeze({
        accept: async (candidate) =>
            transaction(options.pool, async (client) => {
                await lockOperation(client, candidate);
                const replay = await replayFor(client, candidate);
                if (replay) return replay;

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
                const replay = await replayFor(client, candidate);
                if (replay) return replay;

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
                if (conversation.status === "busy") {
                    return { outcome: "busy" };
                }
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
                    return { outcome: "capacity" };
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

        findOwnedMetadata: async (conversationId, ownerId) => {
            const row = await findMetadata(
                options.pool,
                conversationId,
                ownerId,
            );
            return row ? metadataFromRow(row) : undefined;
        },

        findOwnedPage: async (request) => {
            const row = await findMetadata(
                options.pool,
                request.conversationId,
                request.ownerId,
            );
            if (!row) return undefined;
            const result = await options.pool.query<TurnRow>(
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
            const turns = result.rows.slice(0, request.limit).map(turnFromRow);
            const last = turns.at(-1);
            return Object.freeze({
                conversation: metadataFromRow(row),
                turns: Object.freeze(turns),
                ...(result.rows.length > turns.length && last
                    ? { nextAfterSequence: last.sequence }
                    : {}),
            });
        },

        start: async (request) =>
            transaction(options.pool, async (client) => {
                const selected = await client.query<TurnWithConversationRow>(
                    `
            SELECT
              turns.*,
              conversations.owner_id,
              conversations.agent_id,
              conversations.agent_version,
              conversations.config_revision
            FROM agent_conversation_turns AS turns
            JOIN agent_conversations AS conversations
              ON conversations.conversation_id = turns.conversation_id
            WHERE turns.turn_id = $1
            FOR UPDATE OF turns, conversations
          `,
                    [request.turnId],
                );
                const row = selected.rows[0];
                if (row?.status !== "queued") return undefined;
                await client.query(
                    `
            UPDATE agent_conversation_turns
            SET status = 'running', started_at = $2
            WHERE turn_id = $1 AND status = 'queued'
          `,
                    [request.turnId, request.startedAt],
                );
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
                const selected = await client.query<TurnRow>(
                    `
            SELECT *
            FROM agent_conversation_turns
            WHERE turn_id = $1
            FOR UPDATE
          `,
                    [request.turnId],
                );
                const row = selected.rows[0];
                if (row?.status !== "running") return false;

                if (request.completion.status === "succeeded") {
                    await client.query(
                        `
              UPDATE agent_conversation_turns
              SET
                status = 'succeeded',
                public_output = $2::jsonb,
                finished_at = $3
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
                finished_at = $4
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
                return true;
            }),

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
}

interface TurnWithConversationRow extends TurnRow {
    owner_id: string;
    agent_id: string;
    agent_version: string;
    config_revision: string;
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
    },
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
    | "INTERNAL_ERROR"
    | "INVALID_OUTPUT"
    | "RESOURCE_UNAVAILABLE" {
    return (
        value === "AGENT_FAILURE" ||
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

function safePositiveInteger(value: number, label: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${label} is outside the supported range`);
    }
    return parsed;
}

function addMilliseconds(timestamp: string, durationMs: number): string {
    const milliseconds = new Date(timestamp).getTime();
    if (!Number.isFinite(milliseconds)) {
        throw new Error("Agent Conversation timestamp is invalid");
    }
    return new Date(milliseconds + durationMs).toISOString();
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
