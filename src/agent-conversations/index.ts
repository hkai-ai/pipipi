/** 接受多轮 Agent Conversation、执行 caller-scoped 幂等并分页投影公共状态 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentTurnQueue } from "./queue.js";
import type {
    AcceptedAgentTurnInput,
    AgentTurnOutput,
} from "./registration.js";
import { globalAgentLimits, resolveAgentTurnInput } from "./registration.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentResourceResolver } from "./resource.js";
import type {
    AgentConversationStore,
    AgentTurnStatus,
    StoredAgentConversationPage,
    StoredAgentTurn,
} from "./store.js";

const openRequestSchema = z.strictObject({
    agent: z.strictObject({
        id: z.string().min(1),
        version: z.string().min(1),
    }),
    input: z.unknown(),
});

const continueRequestSchema = z.strictObject({
    afterTurnId: z.string().trim().min(1).max(256),
    input: z.unknown(),
});

export type AgentConversationErrorCode =
    | "AGENT_NOT_FOUND"
    | "CONVERSATION_BUSY"
    | "CONVERSATION_NOT_FOUND"
    | "CONVERSATION_SEQUENCE_CONFLICT"
    | "CONVERSATION_TURN_LIMIT_REACHED"
    | "IDEMPOTENCY_CONFLICT"
    | "INVALID_INPUT"
    | "INVALID_QUERY";

export type AgentConversationSubmission =
    | Readonly<{
          accepted: true;
          conversationId: string;
          turnId: string;
          sequence: number;
          status: AgentTurnStatus;
          createdAt: string;
      }>
    | Readonly<{
          accepted: false;
          error: Readonly<{
              code: AgentConversationErrorCode;
              message: string;
          }>;
      }>;

export type AgentConversationView = Readonly<{
    conversationId: string;
    agent: Readonly<{ id: string; version: string }>;
    configRevision: string;
    status: "busy" | "ready";
    turnCount: number;
    lastTurnId: string;
    createdAt: string;
    updatedAt: string;
    turns: readonly AgentTurnView[];
    nextCursor?: string;
}>;

export type AgentConversationLookup =
    | Readonly<{ found: true; conversation: AgentConversationView }>
    | Readonly<{
          found: false;
          error: Readonly<{
              code: "CONVERSATION_NOT_FOUND" | "INVALID_QUERY";
              message: string;
          }>;
      }>;

export type AgentTurnView =
    | Readonly<{
          turnId: string;
          sequence: number;
          status: "queued";
          input: unknown;
          createdAt: string;
      }>
    | Readonly<{
          turnId: string;
          sequence: number;
          status: "running";
          input: unknown;
          createdAt: string;
          startedAt: string;
      }>
    | Readonly<{
          turnId: string;
          sequence: number;
          status: "succeeded";
          input: unknown;
          output: unknown;
          createdAt: string;
          startedAt: string;
          finishedAt: string;
      }>
    | Readonly<{
          turnId: string;
          sequence: number;
          status: "failed";
          input: unknown;
          error: Readonly<{ code: string; message: string }>;
          createdAt: string;
          startedAt: string;
          finishedAt: string;
      }>;

type CallerOperationContext = Readonly<{
    callerId: string;
    idempotencyKey: string;
}>;

export type AgentConversations = Readonly<{
    open: (
        request: unknown,
        context: CallerOperationContext,
    ) => Promise<AgentConversationSubmission>;
    continue: (
        conversationId: string,
        request: unknown,
        context: CallerOperationContext,
    ) => Promise<AgentConversationSubmission>;
    find: (
        conversationId: string,
        context: Readonly<{
            callerId: string;
            after?: string;
            limit?: number;
        }>,
    ) => Promise<AgentConversationLookup>;
}>;

export function createAgentConversations(options: {
    registry: AgentRegistry;
    store: AgentConversationStore;
    queue: AgentTurnQueue;
    resourceResolver?: AgentResourceResolver;
    clock?: () => string;
    createConversationId?: () => string;
    createTurnId?: () => string;
}): AgentConversations {
    const clock = options.clock ?? (() => new Date().toISOString());
    const createConversationId = options.createConversationId ?? randomUUID;
    const createTurnId = options.createTurnId ?? randomUUID;

    return Object.freeze({
        open: async (rawRequest, context) => {
            assertOperationContext(context);
            const parsed = openRequestSchema.safeParse(rawRequest);
            if (!parsed.success) {
                return rejected("INVALID_INPUT", "The Agent input is invalid");
            }
            const registration = options.registry.find(parsed.data.agent);
            if (!registration) {
                return rejected(
                    "AGENT_NOT_FOUND",
                    "The requested Agent version is not registered",
                );
            }
            const acceptance = registration.accept(parsed.data.input);
            if (!acceptance.accepted) {
                return rejected("INVALID_INPUT", "The Agent input is invalid");
            }
            const acceptedInput = await resolveAgentTurnInput(
                acceptance.acceptedInput,
                {
                    ownerId: context.callerId,
                    resolver: options.resourceResolver,
                    registration,
                },
            );
            if (!acceptedInput) {
                return rejected("INVALID_INPUT", "The Agent input is invalid");
            }

            const result = await options.store.accept({
                conversationId: createConversationId(),
                turnId: createTurnId(),
                ownerId: context.callerId,
                idempotencyKey: context.idempotencyKey,
                requestFingerprint: fingerprint({
                    operation: "open",
                    agent: registration.identity,
                    input: acceptedInput,
                }),
                agent: registration.identity,
                configRevision: registration.revision,
                acceptedInput,
                createdAt: clock(),
            });
            if (result.outcome === "conflict") {
                return rejected(
                    "IDEMPOTENCY_CONFLICT",
                    "The idempotency key was already used for a different request",
                );
            }
            if (result.outcome === "created") {
                await enqueue(options.queue, result.turn.turnId);
            }
            return submitted(result.conversation.conversationId, result.turn);
        },

        continue: async (conversationId, rawRequest, context) => {
            assertIdentifier("conversationId", conversationId);
            assertOperationContext(context);
            const parsed = continueRequestSchema.safeParse(rawRequest);
            if (!parsed.success) {
                return rejected("INVALID_INPUT", "The Agent input is invalid");
            }
            const metadata = await options.store.findOwnedMetadata(
                conversationId,
                context.callerId,
            );
            if (!metadata) {
                return rejected(
                    "CONVERSATION_NOT_FOUND",
                    "Agent Conversation not found",
                );
            }
            const registration = options.registry.find(metadata.agent);
            if (
                !registration ||
                registration.revision !== metadata.configRevision
            ) {
                return rejected(
                    "AGENT_NOT_FOUND",
                    "The Conversation Agent version is not available",
                );
            }
            const acceptance = registration.accept(parsed.data.input);
            if (!acceptance.accepted) {
                return rejected("INVALID_INPUT", "The Agent input is invalid");
            }
            const acceptedInput = await resolveAgentTurnInput(
                acceptance.acceptedInput,
                {
                    ownerId: context.callerId,
                    resolver: options.resourceResolver,
                    registration,
                },
            );
            if (!acceptedInput) {
                return rejected("INVALID_INPUT", "The Agent input is invalid");
            }
            const result = await options.store.acceptTurn({
                conversationId,
                turnId: createTurnId(),
                ownerId: context.callerId,
                idempotencyKey: context.idempotencyKey,
                requestFingerprint: fingerprint({
                    operation: "continue",
                    conversationId,
                    afterTurnId: parsed.data.afterTurnId,
                    input: acceptedInput,
                }),
                afterTurnId: parsed.data.afterTurnId,
                acceptedInput,
                maxTurns: registration.limits.maxTurns,
                createdAt: clock(),
            });
            switch (result.outcome) {
                case "conflict":
                    return rejected(
                        "IDEMPOTENCY_CONFLICT",
                        "The idempotency key was already used for a different request",
                    );
                case "not_found":
                    return rejected(
                        "CONVERSATION_NOT_FOUND",
                        "Agent Conversation not found",
                    );
                case "busy":
                    return rejected(
                        "CONVERSATION_BUSY",
                        "Agent Conversation already has an active Turn",
                    );
                case "sequence_conflict":
                    return rejected(
                        "CONVERSATION_SEQUENCE_CONFLICT",
                        "afterTurnId is not the last accepted Turn",
                    );
                case "capacity":
                    return rejected(
                        "CONVERSATION_TURN_LIMIT_REACHED",
                        "Agent Conversation reached its Turn limit",
                    );
                case "created":
                    await enqueue(options.queue, result.turn.turnId);
                    return submitted(conversationId, result.turn);
                case "replayed":
                    return submitted(conversationId, result.turn);
            }
        },

        find: async (conversationId, context) => {
            assertIdentifier("conversationId", conversationId);
            assertContext("callerId", context.callerId);
            const afterSequence = decodeCursor(context.after);
            if (context.after !== undefined && afterSequence === undefined) {
                return lookupRejected("INVALID_QUERY", "Cursor is invalid");
            }
            if (
                context.limit !== undefined &&
                (!Number.isInteger(context.limit) ||
                    context.limit < 1 ||
                    context.limit > globalAgentLimits.maxHistoryPageSize)
            ) {
                return lookupRejected(
                    "INVALID_QUERY",
                    "limit must be between 1 and " +
                        globalAgentLimits.maxHistoryPageSize,
                );
            }
            const metadata = await options.store.findOwnedMetadata(
                conversationId,
                context.callerId,
            );
            if (!metadata) {
                return lookupRejected(
                    "CONVERSATION_NOT_FOUND",
                    "Agent Conversation not found",
                );
            }
            const registration = options.registry.find(metadata.agent);
            const limit = Math.min(
                context.limit ??
                    registration?.limits.historyPageSize ??
                    globalAgentLimits.maxHistoryPageSize,
                registration?.limits.historyPageSize ??
                    globalAgentLimits.maxHistoryPageSize,
            );
            const page = await options.store.findOwnedPage({
                conversationId,
                ownerId: context.callerId,
                ...(afterSequence === undefined ? {} : { afterSequence }),
                limit,
            });
            if (!page) {
                return lookupRejected(
                    "CONVERSATION_NOT_FOUND",
                    "Agent Conversation not found",
                );
            }
            return Object.freeze({
                found: true,
                conversation: await toView(
                    page,
                    context.callerId,
                    options.resourceResolver,
                ),
            });
        },
    });
}

function submitted(
    conversationId: string,
    turn: StoredAgentTurn,
): AgentConversationSubmission {
    return Object.freeze({
        accepted: true,
        conversationId,
        turnId: turn.turnId,
        sequence: turn.sequence,
        status: turn.status,
        createdAt: turn.createdAt,
    });
}

function rejected(
    code: AgentConversationErrorCode,
    message: string,
): AgentConversationSubmission {
    return Object.freeze({
        accepted: false,
        error: Object.freeze({ code, message }),
    });
}

function lookupRejected(
    code: "CONVERSATION_NOT_FOUND" | "INVALID_QUERY",
    message: string,
): AgentConversationLookup {
    return Object.freeze({
        found: false,
        error: Object.freeze({ code, message }),
    });
}

async function toView(
    page: StoredAgentConversationPage,
    ownerId: string,
    resolver: AgentResourceResolver | undefined,
): Promise<AgentConversationView> {
    const conversation = page.conversation;
    return Object.freeze({
        conversationId: conversation.conversationId,
        agent: structuredClone(conversation.agent),
        configRevision: conversation.configRevision,
        status: conversation.busy ? "busy" : "ready",
        turnCount: conversation.turnCount,
        lastTurnId: conversation.lastTurnId,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        turns: Object.freeze(
            await Promise.all(
                page.turns.map((turn) => toTurnView(turn, ownerId, resolver)),
            ),
        ),
        ...(page.nextAfterSequence === undefined
            ? {}
            : { nextCursor: encodeCursor(page.nextAfterSequence) }),
    });
}

async function toTurnView(
    turn: StoredAgentTurn,
    ownerId: string,
    resolver: AgentResourceResolver | undefined,
): Promise<AgentTurnView> {
    const base = {
        turnId: turn.turnId,
        sequence: turn.sequence,
        input: await projectContent(turn.input, ownerId, resolver),
        createdAt: turn.createdAt,
    };
    switch (turn.status) {
        case "queued":
            return Object.freeze({ ...base, status: "queued" });
        case "running":
            return Object.freeze({
                ...base,
                status: "running",
                startedAt: turn.startedAt,
            });
        case "succeeded":
            return Object.freeze({
                ...base,
                status: "succeeded",
                startedAt: turn.startedAt,
                finishedAt: turn.finishedAt,
                output: await projectContent(turn.output, ownerId, resolver),
            });
        case "failed":
            return Object.freeze({
                ...base,
                status: "failed",
                startedAt: turn.startedAt,
                finishedAt: turn.finishedAt,
                error: structuredClone(turn.error),
            });
    }
}

async function projectContent(
    value: AcceptedAgentTurnInput | AgentTurnOutput,
    ownerId: string,
    resolver: AgentResourceResolver | undefined,
): Promise<unknown> {
    return Object.freeze({
        content: Object.freeze(
            await Promise.all(
                value.content.map(async (block) => {
                    if (block.type === "text") {
                        return Object.freeze({ ...block });
                    }
                    const projection = resolver
                        ? await resolver.project({
                              ownerId,
                              resource: block.resource,
                          })
                        : undefined;
                    return Object.freeze({
                        type: "image" as const,
                        resource: structuredClone(block.resource),
                        ...(projection ? structuredClone(projection) : {}),
                    });
                }),
            ),
        ),
    });
}

async function enqueue(queue: AgentTurnQueue, turnId: string): Promise<void> {
    await queue.enqueue({ schemaVersion: 1, turnId });
}

function encodeCursor(sequence: number): string {
    return Buffer.from(String(sequence), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    try {
        const decoded = Buffer.from(value, "base64url").toString("utf8");
        if (!/^[1-9][0-9]*$/.test(decoded)) return undefined;
        const sequence = Number(decoded);
        return Number.isSafeInteger(sequence) ? sequence : undefined;
    } catch {
        return undefined;
    }
}

function fingerprint(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
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

function assertOperationContext(context: CallerOperationContext): void {
    assertContext("callerId", context.callerId);
    assertContext("idempotencyKey", context.idempotencyKey);
}

function assertIdentifier(name: string, value: string): void {
    assertContext(name, value);
}

function assertContext(name: string, value: string): void {
    if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        Buffer.byteLength(value, "utf8") > 512
    ) {
        throw new Error(
            `${name} must be a non-empty string of at most 512 bytes`,
        );
    }
}
