/** 接受首轮 Agent Conversation、执行 caller-scoped 幂等并投影公共状态 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentTurnQueue } from "./queue.js";
import type { AgentRegistry } from "./registry.js";
import type {
    AgentConversationStore,
    AgentTurnStatus,
    StoredAgentConversation,
    StoredAgentTurn,
} from "./store.js";

const openRequestSchema = z.strictObject({
    agent: z.strictObject({
        id: z.string().min(1),
        version: z.string().min(1),
    }),
    input: z.unknown(),
});

export type AgentConversationSubmission =
    | Readonly<{
          accepted: true;
          conversationId: string;
          turnId: string;
          sequence: 1;
          status: AgentTurnStatus;
          createdAt: string;
      }>
    | Readonly<{
          accepted: false;
          error: Readonly<{
              code:
                  | "AGENT_NOT_FOUND"
                  | "IDEMPOTENCY_CONFLICT"
                  | "INVALID_INPUT";
              message: string;
          }>;
      }>;

export type AgentConversationView = Readonly<{
    conversationId: string;
    agent: Readonly<{ id: string; version: string }>;
    configRevision: string;
    status: "busy" | "ready";
    createdAt: string;
    updatedAt: string;
    turns: readonly AgentTurnView[];
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

export type AgentConversations = Readonly<{
    open: (
        request: unknown,
        context: Readonly<{ callerId: string; idempotencyKey: string }>,
    ) => Promise<AgentConversationSubmission>;
    find: (
        conversationId: string,
        context: Readonly<{ callerId: string }>,
    ) => Promise<AgentConversationView | undefined>;
}>;

export function createAgentConversations(options: {
    registry: AgentRegistry;
    store: AgentConversationStore;
    queue: AgentTurnQueue;
    clock?: () => string;
    createConversationId?: () => string;
    createTurnId?: () => string;
}): AgentConversations {
    const clock = options.clock ?? (() => new Date().toISOString());
    const createConversationId = options.createConversationId ?? randomUUID;
    const createTurnId = options.createTurnId ?? randomUUID;

    return Object.freeze({
        open: async (rawRequest, context) => {
            assertContext("callerId", context.callerId);
            assertContext("idempotencyKey", context.idempotencyKey);
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

            const result = await options.store.accept({
                conversationId: createConversationId(),
                turnId: createTurnId(),
                ownerId: context.callerId,
                idempotencyKey: context.idempotencyKey,
                requestFingerprint: fingerprint({
                    agent: registration.identity,
                    input: acceptance.acceptedInput,
                }),
                agent: registration.identity,
                configRevision: registration.revision,
                acceptedInput: acceptance.acceptedInput,
                createdAt: clock(),
            });
            if (result.outcome === "conflict") {
                return rejected(
                    "IDEMPOTENCY_CONFLICT",
                    "The idempotency key was already used for a different request",
                );
            }
            const conversation = result.conversation;
            const turn = conversation.turns[0];
            if (!turn) throw new Error("Agent Conversation has no first Turn");
            if (result.outcome === "created") {
                await options.queue.enqueue({
                    schemaVersion: 1,
                    turnId: turn.turnId,
                });
            }
            return Object.freeze({
                accepted: true,
                conversationId: conversation.conversationId,
                turnId: turn.turnId,
                sequence: 1,
                status: turn.status,
                createdAt: conversation.createdAt,
            });
        },

        find: async (conversationId, context) => {
            assertContext("callerId", context.callerId);
            const conversation = await options.store.findOwned(
                conversationId,
                context.callerId,
            );
            return conversation ? toView(conversation) : undefined;
        },
    });
}

function rejected(
    code: "AGENT_NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "INVALID_INPUT",
    message: string,
): AgentConversationSubmission {
    return Object.freeze({
        accepted: false,
        error: Object.freeze({ code, message }),
    });
}

function toView(conversation: StoredAgentConversation): AgentConversationView {
    return Object.freeze({
        conversationId: conversation.conversationId,
        agent: structuredClone(conversation.agent),
        configRevision: conversation.configRevision,
        status: conversation.turns.some(
            (turn) => turn.status === "queued" || turn.status === "running",
        )
            ? "busy"
            : "ready",
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        turns: Object.freeze(conversation.turns.map(toTurnView)),
    });
}

function toTurnView(turn: StoredAgentTurn): AgentTurnView {
    const base = {
        turnId: turn.turnId,
        sequence: turn.sequence,
        input: structuredClone(turn.input),
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
                output: structuredClone(turn.output),
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
    return `{${Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
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
