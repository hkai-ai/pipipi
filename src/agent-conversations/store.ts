/** 定义 Agent Conversation 权威状态 Interface，并提供首轮 Turn 的内存 Adapter */
import type {
    AcceptedAgentTurnInput,
    AgentIdentity,
    AgentTurnCompletion,
    AgentTurnErrorCode,
    AgentTurnOutput,
} from "./registration.js";

export type AgentTurnStatus = "queued" | "running" | "succeeded" | "failed";

type StoredAgentTurnBase = Readonly<{
    turnId: string;
    sequence: number;
    input: AcceptedAgentTurnInput;
    createdAt: string;
}>;

export type StoredAgentTurn =
    | (StoredAgentTurnBase & Readonly<{ status: "queued" }>)
    | (StoredAgentTurnBase & Readonly<{ status: "running"; startedAt: string }>)
    | (StoredAgentTurnBase &
          Readonly<{
              status: "succeeded";
              startedAt: string;
              finishedAt: string;
              output: AgentTurnOutput;
          }>)
    | (StoredAgentTurnBase &
          Readonly<{
              status: "failed";
              startedAt: string;
              finishedAt: string;
              error: Readonly<{
                  code: AgentTurnErrorCode;
                  message: string;
              }>;
          }>);

export type StoredAgentConversation = Readonly<{
    schemaVersion: 1;
    conversationId: string;
    ownerId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    agent: AgentIdentity;
    configRevision: string;
    createdAt: string;
    updatedAt: string;
    turns: readonly StoredAgentTurn[];
}>;

export type AcceptedAgentConversation = Readonly<{
    conversationId: string;
    turnId: string;
    ownerId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    agent: AgentIdentity;
    configRevision: string;
    acceptedInput: AcceptedAgentTurnInput;
    createdAt: string;
}>;

export type AgentConversationAcceptance =
    | Readonly<{ outcome: "created"; conversation: StoredAgentConversation }>
    | Readonly<{ outcome: "replayed"; conversation: StoredAgentConversation }>
    | Readonly<{ outcome: "conflict" }>;

export type StartedAgentTurn = Readonly<{
    conversationId: string;
    turnId: string;
    agent: AgentIdentity;
    configRevision: string;
    input: AcceptedAgentTurnInput;
}>;

export type AgentConversationStore = Readonly<{
    accept: (
        candidate: AcceptedAgentConversation,
    ) => Promise<AgentConversationAcceptance>;
    findOwned: (
        conversationId: string,
        ownerId: string,
    ) => Promise<StoredAgentConversation | undefined>;
    start: (request: {
        turnId: string;
        startedAt: string;
    }) => Promise<StartedAgentTurn | undefined>;
    complete: (request: {
        turnId: string;
        completedAt: string;
        completion: AgentTurnCompletion;
    }) => Promise<boolean>;
}>;

export function createInMemoryAgentConversationStore(): AgentConversationStore {
    const conversations = new Map<string, StoredAgentConversation>();
    const conversationIdsByTurn = new Map<string, string>();
    const conversationIdsByOwnerAndKey = new Map<string, Map<string, string>>();

    return Object.freeze({
        accept: async (candidate) => {
            const ownerKeys = conversationIdsByOwnerAndKey.get(
                candidate.ownerId,
            );
            const replayId = ownerKeys?.get(candidate.idempotencyKey);
            if (replayId) {
                const existing = conversations.get(replayId);
                if (!existing) {
                    throw new Error(
                        "Agent Conversation idempotency index is inconsistent",
                    );
                }
                return existing.requestFingerprint ===
                    candidate.requestFingerprint
                    ? { outcome: "replayed", conversation: clone(existing) }
                    : { outcome: "conflict" };
            }
            if (
                conversations.has(candidate.conversationId) ||
                conversationIdsByTurn.has(candidate.turnId)
            ) {
                throw new Error("Agent Conversation identity already exists");
            }

            const conversation: StoredAgentConversation = {
                schemaVersion: 1,
                conversationId: candidate.conversationId,
                ownerId: candidate.ownerId,
                idempotencyKey: candidate.idempotencyKey,
                requestFingerprint: candidate.requestFingerprint,
                agent: clone(candidate.agent),
                configRevision: candidate.configRevision,
                createdAt: candidate.createdAt,
                updatedAt: candidate.createdAt,
                turns: [
                    {
                        turnId: candidate.turnId,
                        sequence: 1,
                        status: "queued",
                        input: clone(candidate.acceptedInput),
                        createdAt: candidate.createdAt,
                    },
                ],
            };
            const keys = ownerKeys ?? new Map<string, string>();
            keys.set(candidate.idempotencyKey, candidate.conversationId);
            conversationIdsByOwnerAndKey.set(candidate.ownerId, keys);
            conversationIdsByTurn.set(
                candidate.turnId,
                candidate.conversationId,
            );
            conversations.set(candidate.conversationId, clone(conversation));
            return { outcome: "created", conversation: clone(conversation) };
        },

        findOwned: async (conversationId, ownerId) => {
            const conversation = conversations.get(conversationId);
            return conversation?.ownerId === ownerId
                ? clone(conversation)
                : undefined;
        },

        start: async (request) => {
            const conversationId = conversationIdsByTurn.get(request.turnId);
            const conversation = conversationId
                ? conversations.get(conversationId)
                : undefined;
            const turn = conversation?.turns.find(
                (candidate) => candidate.turnId === request.turnId,
            );
            if (!conversation || turn?.status !== "queued") return undefined;

            const running: StoredAgentTurn = {
                ...turn,
                status: "running",
                startedAt: request.startedAt,
            };
            conversations.set(
                conversation.conversationId,
                replaceTurn(conversation, running, request.startedAt),
            );
            return clone({
                conversationId: conversation.conversationId,
                turnId: turn.turnId,
                agent: conversation.agent,
                configRevision: conversation.configRevision,
                input: turn.input,
            });
        },

        complete: async (request) => {
            const conversationId = conversationIdsByTurn.get(request.turnId);
            const conversation = conversationId
                ? conversations.get(conversationId)
                : undefined;
            const turn = conversation?.turns.find(
                (candidate) => candidate.turnId === request.turnId,
            );
            if (!conversation || turn?.status !== "running") return false;

            const terminal: StoredAgentTurn =
                request.completion.status === "succeeded"
                    ? {
                          ...turn,
                          status: "succeeded",
                          finishedAt: request.completedAt,
                          output: clone(request.completion.output),
                      }
                    : {
                          ...turn,
                          status: "failed",
                          finishedAt: request.completedAt,
                          error: clone(request.completion.error),
                      };
            conversations.set(
                conversation.conversationId,
                replaceTurn(conversation, terminal, request.completedAt),
            );
            return true;
        },
    });
}

function replaceTurn(
    conversation: StoredAgentConversation,
    turn: StoredAgentTurn,
    updatedAt: string,
): StoredAgentConversation {
    return clone({
        ...conversation,
        updatedAt,
        turns: conversation.turns.map((candidate) =>
            candidate.turnId === turn.turnId ? turn : candidate,
        ),
    });
}

function clone<Value>(value: Value): Value {
    return structuredClone(value);
}
