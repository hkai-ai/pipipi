/** 为 Interactive Agent 绑定串行 Process Tool、预算、稳定调用 identity 与内存 Ledger */
import { createHash } from "node:crypto";
import type {
    ProcessToolInvocation,
    ProcessToolRuntime,
    ProcessToolSideEffect,
} from "../agent-runtime/process-tools.js";
import type { JsonValue } from "../process-runtime/index.js";
import type { AgentTurnDraftCompletion } from "./registration.js";

export const globalAgentToolLimits = Object.freeze({
    maxCallsPerTurn: 6,
    maxPricedCallsPerTurn: 1,
    maxPricedCallsPerConversation: 10,
});

export type AgentToolLimits = Readonly<{
    maxCallsPerTurn: number;
    maxPricedCallsPerTurn: number;
    maxPricedCallsPerConversation: number;
}>;

export type AgentProcessTool = Readonly<{
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
    execute: (input: unknown) => Promise<JsonValue>;
}>;

export type AgentToolLedgerRecord = Readonly<{
    invocationId: string;
    conversationId: string;
    turnId: string;
    invocation: number;
    toolName: string;
    process: string;
    version: string;
    inputFingerprint: string;
    sideEffect: ProcessToolSideEffect;
    status: "succeeded" | "failed";
    output?: JsonValue;
    error?: Readonly<{ code: string; message: string }>;
}>;

export type BoundAgentProcessTools = Readonly<{
    tools: readonly AgentProcessTool[];
    records: () => readonly AgentToolLedgerRecord[];
}>;

export type AgentToolLedger = Readonly<{
    bind: (request: {
        conversationId: string;
        turnId: string;
        runtime: ProcessToolRuntime;
        limits: AgentToolLimits;
        signal: AbortSignal;
    }) => BoundAgentProcessTools;
    records: (turnId: string) => readonly AgentToolLedgerRecord[];
}>;

type StoredInvocation = Readonly<{
    fingerprint: string;
    record: AgentToolLedgerRecord;
}>;

export function createInMemoryAgentToolLedger(): AgentToolLedger {
    const byIdentity = new Map<string, StoredInvocation>();
    const recordsByTurn = new Map<string, AgentToolLedgerRecord[]>();
    const recordsByConversation = new Map<string, AgentToolLedgerRecord[]>();
    const queues = new Map<string, Promise<unknown>>();
    const serialize = <Result>(
        turnId: string,
        operation: () => Promise<Result>,
    ) => {
        const queue = queues.get(turnId) ?? Promise.resolve();
        const run = queue.then(operation, operation);
        const tail = run.catch(() => undefined);
        queues.set(turnId, tail);
        void tail.finally(() => {
            if (queues.get(turnId) === tail) queues.delete(turnId);
        });
        return run;
    };

    return Object.freeze({
        bind: (request) => {
            assertLimits(request.limits);
            let nextInvocation = 0;
            const sideEffects = new Map(
                request.runtime.specs.map((spec) => [
                    spec.toolName,
                    spec.sideEffect,
                ]),
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
                            return serialize(request.turnId, async () => {
                                const fingerprint = agentToolInputFingerprint({
                                    toolName: descriptor.name,
                                    input,
                                });
                                const invocationId = agentToolInvocationId(
                                    request.turnId,
                                    invocation,
                                );
                                const replay = byIdentity.get(invocationId);
                                if (replay) {
                                    return replay.fingerprint === fingerprint
                                        ? publicRecord(replay.record)
                                        : refusal(
                                              "TOOL_INVOCATION_CONFLICT",
                                              "The Tool invocation identity was used with different input",
                                          );
                                }
                                const turnRecords =
                                    recordsByTurn.get(request.turnId) ?? [];
                                if (
                                    turnRecords.length >=
                                    request.limits.maxCallsPerTurn
                                ) {
                                    return refusal(
                                        "TOOL_BUDGET_EXHAUSTED",
                                        "No further Tool call is allowed in this Turn",
                                    );
                                }
                                const sideEffect = sideEffects.get(
                                    descriptor.name,
                                );
                                if (!sideEffect) {
                                    return refusal(
                                        "TOOL_NOT_ALLOWED",
                                        "The Tool is not allowed",
                                    );
                                }
                                const conversationRecords =
                                    recordsByConversation.get(
                                        request.conversationId,
                                    ) ?? [];
                                if (
                                    sideEffect === "priced" &&
                                    turnRecords.filter(isPriced).length >=
                                        request.limits.maxPricedCallsPerTurn
                                ) {
                                    return refusal(
                                        "PRICED_TURN_BUDGET_EXHAUSTED",
                                        "No further priced Tool call is allowed in this Turn",
                                    );
                                }
                                if (
                                    sideEffect === "priced" &&
                                    conversationRecords.filter(isPriced)
                                        .length >=
                                        request.limits
                                            .maxPricedCallsPerConversation
                                ) {
                                    return refusal(
                                        "PRICED_CONVERSATION_BUDGET_EXHAUSTED",
                                        "No further priced Tool call is allowed in this Conversation",
                                    );
                                }

                                const result = await request.runtime.invoke({
                                    toolName: descriptor.name,
                                    input,
                                    parentRunId: request.turnId,
                                    invocation,
                                    signal: request.signal,
                                });
                                const record = ledgerRecord(
                                    request,
                                    descriptor.name,
                                    invocationId,
                                    fingerprint,
                                    result,
                                );
                                byIdentity.set(invocationId, {
                                    fingerprint,
                                    record,
                                });
                                turnRecords.push(record);
                                recordsByTurn.set(request.turnId, turnRecords);
                                conversationRecords.push(record);
                                recordsByConversation.set(
                                    request.conversationId,
                                    conversationRecords,
                                );
                                return publicRecord(record);
                            });
                        },
                    }),
            );
            return Object.freeze({
                tools: Object.freeze(tools),
                records: () =>
                    Object.freeze([
                        ...(recordsByTurn.get(request.turnId) ?? []),
                    ]),
            });
        },
        records: (turnId) =>
            Object.freeze([...(recordsByTurn.get(turnId) ?? [])]),
    });
}

export function defineAgentToolLimits(
    requested: Partial<AgentToolLimits> | undefined,
): AgentToolLimits {
    const limits = {
        maxCallsPerTurn:
            requested?.maxCallsPerTurn ?? globalAgentToolLimits.maxCallsPerTurn,
        maxPricedCallsPerTurn:
            requested?.maxPricedCallsPerTurn ??
            globalAgentToolLimits.maxPricedCallsPerTurn,
        maxPricedCallsPerConversation:
            requested?.maxPricedCallsPerConversation ??
            globalAgentToolLimits.maxPricedCallsPerConversation,
    };
    assertLimits(limits);
    return Object.freeze(limits);
}

export function agentToolInvocationId(
    turnId: string,
    invocation: number,
): string {
    if (
        typeof turnId !== "string" ||
        turnId.trim().length === 0 ||
        !Number.isSafeInteger(invocation) ||
        invocation < 1
    ) {
        throw new Error("Agent Tool invocation identity is invalid");
    }
    return `${turnId}.${invocation}`;
}

export function isAgentOutputDerivedFromTools(
    draft: AgentTurnDraftCompletion,
    records: readonly AgentToolLedgerRecord[],
): boolean {
    if (draft.status === "failed") return true;
    const values = new Set<string>();
    for (const record of records) {
        if (record.status === "succeeded" && record.output !== undefined) {
            collectJsonValues(record.output, values);
        }
    }
    return draft.output.content.every(
        (block) =>
            block.type === "image" || values.has(JSON.stringify(block.text)),
    );
}

function ledgerRecord(
    request: {
        conversationId: string;
        turnId: string;
    },
    toolName: string,
    invocationId: string,
    fingerprint: string,
    result: ProcessToolInvocation,
): AgentToolLedgerRecord {
    return Object.freeze({
        invocationId,
        conversationId: request.conversationId,
        turnId: request.turnId,
        invocation: result.invocation,
        toolName,
        process: result.process,
        version: result.version,
        inputFingerprint: fingerprint,
        sideEffect: result.sideEffect,
        status: result.status,
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.error ? { error: result.error } : {}),
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

function isPriced(record: AgentToolLedgerRecord): boolean {
    return record.sideEffect === "priced";
}

function assertLimits(limits: AgentToolLimits): void {
    for (const [name, maximum] of Object.entries(globalAgentToolLimits)) {
        const value = limits[name as keyof AgentToolLimits];
        if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
            throw new Error(
                "Agent Tool " +
                    name +
                    " must be an integer between 0 and " +
                    maximum,
            );
        }
    }
    if (limits.maxCallsPerTurn < 1) {
        throw new Error("Agent Tool maxCallsPerTurn must be positive");
    }
}

export function agentToolInputFingerprint(value: unknown): string {
    return createHash("sha256")
        .update(canonicalJson(value), "utf8")
        .digest("hex");
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    return (
        "{" +
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(
                ([key, item]) =>
                    `${JSON.stringify(key)}:${canonicalJson(item)}`,
            )
            .join(",") +
        "}"
    );
}

function collectJsonValues(value: JsonValue, into: Set<string>): void {
    into.add(JSON.stringify(value));
    if (value === null || typeof value !== "object") return;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
        collectJsonValues(child, into);
    }
}
