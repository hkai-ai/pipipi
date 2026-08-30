/** 用 PostgreSQL 持久化 Agent Process Tool 调用、预算、执行 fencing 与公开结果 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
    ProcessToolInvocation,
    ProcessToolSideEffect,
} from "../agent-runtime/process-tools.js";
import type { JsonValue, ProcessErrorCode } from "../process-runtime/index.js";
import {
    type AgentProcessTool,
    type AgentToolLedger,
    type AgentToolLedgerRecord,
    type AgentToolLimits,
    agentToolInputFingerprint,
    agentToolInvocationId,
    globalAgentToolLimits,
} from "./tools.js";

const afterCommitError = Object.freeze({
    code: "DEPENDENCY_FAILURE_AFTER_COMMIT" as const,
    message: "A priced Tool may have completed and will not be retried",
});
const internalToolError = Object.freeze({
    code: "INTERNAL_ERROR" as const,
    message: "The Process Tool could not be completed",
});

export type AgentToolActivity = Readonly<{
    schemaVersion: 1;
    event: "agent_tool_started" | "agent_tool_finished";
    invocationId: string;
    conversationId: string;
    turnId: string;
    invocation: number;
    process: string;
    version: string;
    sideEffect: ProcessToolSideEffect;
    status?: "succeeded" | "failed";
    durationMs?: number;
    timestamp: string;
}>;

export type PostgresAgentToolLedger = AgentToolLedger &
    Readonly<{
        findRecords: (
            turnId: string,
        ) => Promise<readonly AgentToolLedgerRecord[]>;
        ready: () => Promise<void>;
    }>;

type Preparation =
    | Readonly<{ kind: "execute"; invocationId: string }>
    | Readonly<{ kind: "record"; record: AgentToolLedgerRecord }>
    | Readonly<{ kind: "refusal"; result: JsonValue }>;

export function createPostgresAgentToolLedger(options: {
    pool: Pool;
    createExecutionToken?: () => string;
    clock?: () => string;
    logSink?: (activity: AgentToolActivity) => void;
}): PostgresAgentToolLedger {
    const clock = options.clock ?? (() => new Date().toISOString());
    const createExecutionToken = options.createExecutionToken ?? randomUUID;
    const observedByTurn = new Map<string, AgentToolLedgerRecord[]>();
    const queues = new Map<string, Promise<unknown>>();

    return Object.freeze({
        bind: (request) => {
            assertLimits(request.limits);
            let nextInvocation = 0;
            const localRecords: AgentToolLedgerRecord[] = [];
            const specs = new Map(
                request.runtime.specs.map((spec) => [spec.toolName, spec]),
            );
            const tools = request.runtime.descriptors.map(
                (descriptor): AgentProcessTool =>
                    Object.freeze({
                        name: descriptor.name,
                        description: descriptor.description,
                        parameters: descriptor.parameters,
                        execute: (input) => {
                            nextInvocation += 1;
                            const invocation = nextInvocation;
                            return serialize(
                                request.turnId,
                                queues,
                                async () => {
                                    const spec = specs.get(descriptor.name);
                                    if (!spec) {
                                        return refusal(
                                            "TOOL_NOT_ALLOWED",
                                            "The Tool is not allowed",
                                        );
                                    }
                                    const invocationId = agentToolInvocationId(
                                        request.turnId,
                                        invocation,
                                    );
                                    const fingerprint =
                                        agentToolInputFingerprint({
                                            toolName: descriptor.name,
                                            input,
                                        });
                                    const prepared = await prepareInvocation(
                                        options.pool,
                                        {
                                            conversationId:
                                                request.conversationId,
                                            turnId: request.turnId,
                                            invocation,
                                            invocationId,
                                            toolName: descriptor.name,
                                            process: spec.process,
                                            version: spec.version,
                                            fingerprint,
                                            sideEffect: spec.sideEffect,
                                            limits: request.limits,
                                            timestamp: clock(),
                                        },
                                    );
                                    if (prepared.kind === "refusal") {
                                        return prepared.result;
                                    }
                                    if (prepared.kind === "record") {
                                        observe(
                                            prepared.record,
                                            localRecords,
                                            observedByTurn,
                                        );
                                        return publicRecord(prepared.record);
                                    }
                                    const executionToken =
                                        createExecutionToken();
                                    const startedAt = clock();
                                    const started = await startInvocation(
                                        options.pool,
                                        {
                                            invocationId,
                                            executionToken,
                                            sideEffect: spec.sideEffect,
                                            timestamp: startedAt,
                                        },
                                    );
                                    if (started) {
                                        observe(
                                            started,
                                            localRecords,
                                            observedByTurn,
                                        );
                                        return publicRecord(started);
                                    }
                                    writeActivity(options.logSink, {
                                        schemaVersion: 1,
                                        event: "agent_tool_started",
                                        invocationId,
                                        conversationId: request.conversationId,
                                        turnId: request.turnId,
                                        invocation,
                                        process: spec.process,
                                        version: spec.version,
                                        sideEffect: spec.sideEffect,
                                        timestamp: startedAt,
                                    });
                                    let result: ProcessToolInvocation;
                                    let uncertain = false;
                                    try {
                                        result = await request.runtime.invoke({
                                            toolName: descriptor.name,
                                            input,
                                            parentRunId: request.turnId,
                                            invocation,
                                            signal: request.signal,
                                        });
                                    } catch {
                                        uncertain =
                                            spec.sideEffect === "priced";
                                        result = failedInvocation(
                                            invocation,
                                            spec,
                                            uncertain
                                                ? afterCommitError
                                                : internalToolError,
                                        );
                                    }
                                    let record: AgentToolLedgerRecord;
                                    try {
                                        record = recordFromResult({
                                            invocationId,
                                            conversationId:
                                                request.conversationId,
                                            turnId: request.turnId,
                                            toolName: descriptor.name,
                                            fingerprint,
                                            spec,
                                            result,
                                        });
                                    } catch {
                                        uncertain =
                                            spec.sideEffect === "priced";
                                        record = recordFromResult({
                                            invocationId,
                                            conversationId:
                                                request.conversationId,
                                            turnId: request.turnId,
                                            toolName: descriptor.name,
                                            fingerprint,
                                            spec,
                                            result: failedInvocation(
                                                invocation,
                                                spec,
                                                uncertain
                                                    ? afterCommitError
                                                    : internalToolError,
                                            ),
                                        });
                                    }
                                    let stored: AgentToolLedgerRecord;
                                    try {
                                        stored =
                                            (await finishInvocation(
                                                options.pool,
                                                {
                                                    invocationId,
                                                    executionToken,
                                                    record,
                                                    uncertain,
                                                    timestamp: clock(),
                                                },
                                            )) ??
                                            uncertainRecord(
                                                record,
                                                spec.sideEffect,
                                            );
                                    } catch {
                                        stored = uncertainRecord(
                                            record,
                                            spec.sideEffect,
                                        );
                                    }
                                    observe(
                                        stored,
                                        localRecords,
                                        observedByTurn,
                                    );
                                    writeActivity(options.logSink, {
                                        schemaVersion: 1,
                                        event: "agent_tool_finished",
                                        invocationId,
                                        conversationId: request.conversationId,
                                        turnId: request.turnId,
                                        invocation,
                                        process: spec.process,
                                        version: spec.version,
                                        sideEffect: spec.sideEffect,
                                        status: stored.status,
                                        durationMs: durationBetween(
                                            startedAt,
                                            clock(),
                                        ),
                                        timestamp: clock(),
                                    });
                                    return publicRecord(stored);
                                },
                            );
                        },
                    }),
            );
            return Object.freeze({
                tools: Object.freeze(tools),
                records: () => Object.freeze([...localRecords]),
            });
        },
        records: (turnId) =>
            Object.freeze([...(observedByTurn.get(turnId) ?? [])]),
        findRecords: async (turnId) => {
            const result = await options.pool.query<InvocationRow>(
                `
          SELECT *
          FROM agent_tool_invocations
          WHERE turn_id = $1
            AND status IN ('succeeded', 'failed', 'uncertain')
          ORDER BY invocation
        `,
                [turnId],
            );
            return Object.freeze(result.rows.map(recordFromRow));
        },
        ready: async () => {
            const result = await options.pool.query<{
                table_name: string | null;
            }>(
                "SELECT to_regclass('public.agent_tool_invocations')::text AS table_name",
            );
            if (result.rows[0]?.table_name !== "agent_tool_invocations") {
                throw new Error(
                    "Agent Tool Ledger PostgreSQL schema is unavailable",
                );
            }
        },
    });
}

async function prepareInvocation(
    pool: Pool,
    request: {
        conversationId: string;
        turnId: string;
        invocation: number;
        invocationId: string;
        toolName: string;
        process: string;
        version: string;
        fingerprint: string;
        sideEffect: ProcessToolSideEffect;
        limits: AgentToolLimits;
        timestamp: string;
    },
): Promise<Preparation> {
    return transaction(pool, async (client) => {
        const turn = await client.query<{ conversation_id: string }>(
            `
        SELECT turns.conversation_id
        FROM agent_conversation_turns AS turns
        JOIN agent_conversations AS conversations
          ON conversations.conversation_id = turns.conversation_id
        WHERE turns.turn_id = $1 AND conversations.conversation_id = $2
        FOR UPDATE OF conversations
      `,
            [request.turnId, request.conversationId],
        );
        if (!turn.rows[0]) {
            throw new Error("Agent Tool invocation owner is unavailable");
        }
        const selected = await client.query<InvocationRow>(
            `
        SELECT *
        FROM agent_tool_invocations
        WHERE invocation_id = $1
        FOR UPDATE
      `,
            [request.invocationId],
        );
        const existing = selected.rows[0];
        if (existing) {
            if (existing.input_fingerprint !== request.fingerprint) {
                return {
                    kind: "refusal",
                    result: refusal(
                        "TOOL_INVOCATION_CONFLICT",
                        "The Tool invocation identity was used with different input",
                    ),
                };
            }
            assertInvocationIdentity(existing, request);
            if (existing.status === "prepared") {
                return { kind: "execute", invocationId: request.invocationId };
            }
            if (
                existing.status === "executing" &&
                existing.side_effect === "none"
            ) {
                return { kind: "execute", invocationId: request.invocationId };
            }
            if (existing.status === "executing") {
                const uncertain = await markUncertain(
                    client,
                    existing,
                    request.timestamp,
                );
                return { kind: "record", record: recordFromRow(uncertain) };
            }
            return { kind: "record", record: recordFromRow(existing) };
        }

        const counts = await client.query<{
            turn_count: number | string;
            turn_priced_count: number | string;
            conversation_priced_count: number | string;
        }>(
            `
        SELECT
          COUNT(*) FILTER (WHERE turn_id = $2) AS turn_count,
          COUNT(*) FILTER (WHERE turn_id = $2 AND side_effect = 'priced')
            AS turn_priced_count,
          COUNT(*) FILTER (WHERE side_effect = 'priced')
            AS conversation_priced_count
        FROM agent_tool_invocations
        WHERE conversation_id = $1
      `,
            [request.conversationId, request.turnId],
        );
        const count = counts.rows[0];
        if (!count) throw new Error("Agent Tool budget count is unavailable");
        if (Number(count.turn_count) >= request.limits.maxCallsPerTurn) {
            return {
                kind: "refusal",
                result: refusal(
                    "TOOL_BUDGET_EXHAUSTED",
                    "No further Tool call is allowed in this Turn",
                ),
            };
        }
        if (
            request.sideEffect === "priced" &&
            Number(count.turn_priced_count) >=
                request.limits.maxPricedCallsPerTurn
        ) {
            return {
                kind: "refusal",
                result: refusal(
                    "PRICED_TURN_BUDGET_EXHAUSTED",
                    "No further priced Tool call is allowed in this Turn",
                ),
            };
        }
        if (
            request.sideEffect === "priced" &&
            Number(count.conversation_priced_count) >=
                request.limits.maxPricedCallsPerConversation
        ) {
            return {
                kind: "refusal",
                result: refusal(
                    "PRICED_CONVERSATION_BUDGET_EXHAUSTED",
                    "No further priced Tool call is allowed in this Conversation",
                ),
            };
        }
        await client.query(
            `
        INSERT INTO agent_tool_invocations (
          invocation_id,
          conversation_id,
          turn_id,
          invocation,
          tool_name,
          process_id,
          process_version,
          input_fingerprint,
          side_effect,
          child_run_id,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $1, 'prepared', $10, $10)
      `,
            [
                request.invocationId,
                request.conversationId,
                request.turnId,
                request.invocation,
                request.toolName,
                request.process,
                request.version,
                request.fingerprint,
                request.sideEffect,
                request.timestamp,
            ],
        );
        return { kind: "execute", invocationId: request.invocationId };
    });
}

async function startInvocation(
    pool: Pool,
    request: {
        invocationId: string;
        executionToken: string;
        sideEffect: ProcessToolSideEffect;
        timestamp: string;
    },
): Promise<AgentToolLedgerRecord | undefined> {
    return transaction(pool, async (client) => {
        const updated = await client.query<InvocationRow>(
            `
        UPDATE agent_tool_invocations
        SET
          status = 'executing',
          execution_token = $2,
          revision = revision + 1,
          started_at = COALESCE(started_at, $3),
          finished_at = NULL,
          error_code = NULL,
          public_error_message = NULL,
          updated_at = $3
        WHERE invocation_id = $1
          AND (
            status = 'prepared'
            OR (status = 'executing' AND side_effect = 'none')
          )
        RETURNING *
      `,
            [request.invocationId, request.executionToken, request.timestamp],
        );
        if (updated.rows[0]) return undefined;
        const selected = await client.query<InvocationRow>(
            "SELECT * FROM agent_tool_invocations WHERE invocation_id = $1 FOR UPDATE",
            [request.invocationId],
        );
        const row = selected.rows[0];
        if (!row) throw new Error("Agent Tool invocation is unavailable");
        if (row.status === "executing" && request.sideEffect === "priced") {
            return recordFromRow(
                await markUncertain(client, row, request.timestamp),
            );
        }
        if (
            row.status === "succeeded" ||
            row.status === "failed" ||
            row.status === "uncertain"
        ) {
            return recordFromRow(row);
        }
        throw new Error("Agent Tool invocation could not be started");
    });
}

async function finishInvocation(
    pool: Pool,
    request: {
        invocationId: string;
        executionToken: string;
        record: AgentToolLedgerRecord;
        uncertain: boolean;
        timestamp: string;
    },
): Promise<AgentToolLedgerRecord | undefined> {
    return transaction(pool, async (client) => {
        const status = request.uncertain ? "uncertain" : request.record.status;
        const updated = await client.query<InvocationRow>(
            `
        UPDATE agent_tool_invocations
        SET
          status = $3,
          execution_token = NULL,
          revision = revision + 1,
          public_output = $4::jsonb,
          error_code = $5,
          public_error_message = $6,
          finished_at = $7,
          updated_at = $7
        WHERE invocation_id = $1
          AND execution_token = $2
          AND status = 'executing'
        RETURNING *
      `,
            [
                request.invocationId,
                request.executionToken,
                status,
                request.record.output === undefined
                    ? null
                    : JSON.stringify(request.record.output),
                request.record.error?.code ?? null,
                request.record.error?.message ?? null,
                request.timestamp,
            ],
        );
        if (updated.rows[0]) return recordFromRow(updated.rows[0]);
        const selected = await client.query<InvocationRow>(
            "SELECT * FROM agent_tool_invocations WHERE invocation_id = $1",
            [request.invocationId],
        );
        const row = selected.rows[0];
        return row && isTerminal(row.status) ? recordFromRow(row) : undefined;
    });
}

async function markUncertain(
    client: PoolClient,
    row: InvocationRow,
    timestamp: string,
): Promise<InvocationRow> {
    const updated = await client.query<InvocationRow>(
        `
      UPDATE agent_tool_invocations
      SET
        status = 'uncertain',
        execution_token = NULL,
        revision = revision + 1,
        error_code = $2,
        public_error_message = $3,
        finished_at = $4,
        updated_at = $4
      WHERE invocation_id = $1 AND status = 'executing'
      RETURNING *
    `,
        [
            row.invocation_id,
            afterCommitError.code,
            afterCommitError.message,
            timestamp,
        ],
    );
    return updated.rows[0] ?? row;
}

function assertInvocationIdentity(
    row: InvocationRow,
    request: {
        conversationId: string;
        turnId: string;
        invocation: number;
        invocationId: string;
        toolName: string;
        process: string;
        version: string;
        sideEffect: ProcessToolSideEffect;
    },
): void {
    if (
        row.conversation_id !== request.conversationId ||
        row.turn_id !== request.turnId ||
        row.invocation !== request.invocation ||
        row.invocation_id !== request.invocationId ||
        row.tool_name !== request.toolName ||
        row.process_id !== request.process ||
        row.process_version !== request.version ||
        row.side_effect !== request.sideEffect ||
        row.child_run_id !== request.invocationId
    ) {
        throw new Error("Agent Tool invocation identity is inconsistent");
    }
}

function recordFromResult(request: {
    invocationId: string;
    conversationId: string;
    turnId: string;
    toolName: string;
    fingerprint: string;
    spec: Readonly<{
        process: string;
        version: string;
        sideEffect: ProcessToolSideEffect;
    }>;
    result: ProcessToolInvocation;
}): AgentToolLedgerRecord {
    if (
        request.result.process !== request.spec.process ||
        request.result.version !== request.spec.version ||
        request.result.sideEffect !== request.spec.sideEffect
    ) {
        throw new Error("Process Tool result identity is inconsistent");
    }
    return Object.freeze({
        invocationId: request.invocationId,
        conversationId: request.conversationId,
        turnId: request.turnId,
        invocation: request.result.invocation,
        toolName: request.toolName,
        process: request.result.process,
        version: request.result.version,
        inputFingerprint: request.fingerprint,
        sideEffect: request.result.sideEffect,
        status: request.result.status,
        ...(request.result.output === undefined
            ? {}
            : { output: request.result.output }),
        ...(request.result.error ? { error: request.result.error } : {}),
    });
}

function recordFromRow(row: InvocationRow): AgentToolLedgerRecord {
    if (!isTerminal(row.status)) {
        throw new Error("Agent Tool invocation is not terminal");
    }
    return Object.freeze({
        invocationId: row.invocation_id,
        conversationId: row.conversation_id,
        turnId: row.turn_id,
        invocation: row.invocation,
        toolName: row.tool_name,
        process: row.process_id,
        version: row.process_version,
        inputFingerprint: row.input_fingerprint,
        sideEffect: row.side_effect,
        status: row.status === "succeeded" ? "succeeded" : "failed",
        ...(row.public_output === null
            ? {}
            : { output: row.public_output as JsonValue }),
        ...(row.error_code && row.public_error_message
            ? {
                  error: Object.freeze({
                      code: row.error_code,
                      message: row.public_error_message,
                  }),
              }
            : {}),
    });
}

function uncertainRecord(
    record: AgentToolLedgerRecord,
    sideEffect: ProcessToolSideEffect,
): AgentToolLedgerRecord {
    return sideEffect === "priced"
        ? Object.freeze({
              ...record,
              status: "failed" as const,
              output: undefined,
              error: afterCommitError,
          })
        : Object.freeze({
              ...record,
              status: "failed" as const,
              output: undefined,
              error: internalToolError,
          });
}

function failedInvocation(
    invocation: number,
    spec: Readonly<{
        process: string;
        version: string;
        sideEffect: ProcessToolSideEffect;
    }>,
    error: Readonly<{ code: ProcessErrorCode; message: string }>,
): ProcessToolInvocation {
    return Object.freeze({
        invocation,
        process: spec.process,
        version: spec.version,
        sideEffect: spec.sideEffect,
        status: "failed",
        error,
    });
}

function publicRecord(record: AgentToolLedgerRecord): JsonValue {
    return Object.freeze({
        invocation: record.invocation,
        process: record.process,
        version: record.version,
        status: record.status,
        ...(record.output === undefined ? {} : { output: record.output }),
        ...(record.error ? { error: record.error } : {}),
    });
}

function refusal(code: string, message: string): JsonValue {
    return Object.freeze({ error: Object.freeze({ code, message }) });
}

function observe(
    record: AgentToolLedgerRecord,
    local: AgentToolLedgerRecord[],
    byTurn: Map<string, AgentToolLedgerRecord[]>,
): void {
    if (
        !local.some(
            (candidate) => candidate.invocationId === record.invocationId,
        )
    ) {
        local.push(record);
    }
    const records = byTurn.get(record.turnId) ?? [];
    const index = records.findIndex(
        (candidate) => candidate.invocationId === record.invocationId,
    );
    if (index === -1) records.push(record);
    else records[index] = record;
    byTurn.set(record.turnId, records);
}

function assertLimits(limits: AgentToolLimits): void {
    for (const [name, maximum] of Object.entries(globalAgentToolLimits)) {
        const value = limits[name as keyof AgentToolLimits];
        if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
            throw new Error(
                `Agent Tool ${name} must be an integer between 0 and ${maximum}`,
            );
        }
    }
    if (limits.maxCallsPerTurn < 1) {
        throw new Error("Agent Tool maxCallsPerTurn must be positive");
    }
}

function isTerminal(status: string): boolean {
    return (
        status === "succeeded" || status === "failed" || status === "uncertain"
    );
}

function durationBetween(startedAt: string, finishedAt: string): number {
    return Math.max(
        0,
        new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    );
}

function writeActivity(
    sink: ((activity: AgentToolActivity) => void) | undefined,
    activity: AgentToolActivity,
): void {
    try {
        sink?.(Object.freeze(activity));
    } catch {
        // Activity is best-effort and never changes Tool execution.
    }
}

function serialize<Result>(
    turnId: string,
    queues: Map<string, Promise<unknown>>,
    operation: () => Promise<Result>,
): Promise<Result> {
    const queue = queues.get(turnId) ?? Promise.resolve();
    const run = queue.then(operation, operation);
    const tail = run.catch(() => undefined);
    queues.set(turnId, tail);
    void tail.finally(() => {
        if (queues.get(turnId) === tail) queues.delete(turnId);
    });
    return run;
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
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

interface InvocationRow extends QueryResultRow {
    invocation_id: string;
    conversation_id: string;
    turn_id: string;
    invocation: number;
    tool_name: string;
    process_id: string;
    process_version: string;
    input_fingerprint: string;
    side_effect: ProcessToolSideEffect;
    child_run_id: string;
    status: "prepared" | "executing" | "succeeded" | "failed" | "uncertain";
    execution_token: string | null;
    revision: number | string;
    public_output: unknown | null;
    error_code: string | null;
    public_error_message: string | null;
    created_at: Date | string;
    started_at: Date | string | null;
    finished_at: Date | string | null;
    updated_at: Date | string;
}
