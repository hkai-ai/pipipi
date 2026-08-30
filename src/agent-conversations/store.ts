/** 定义 Agent Conversation 权威状态、原子追加和分页 Interface，并提供内存 Adapter */
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
    agent: AgentIdentity;
    configRevision: string;
    createdAt: string;
    updatedAt: string;
    turns: readonly StoredAgentTurn[];
}>;

export type StoredAgentConversationMetadata = Omit<
    StoredAgentConversation,
    "turns"
> &
    Readonly<{
        turnCount: number;
        lastTurnId: string;
        busy: boolean;
    }>;

export type StoredAgentConversationPage = Readonly<{
    conversation: StoredAgentConversationMetadata;
    turns: readonly StoredAgentTurn[];
    nextAfterSequence?: number;
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

export type AcceptedAgentTurn = Readonly<{
    conversationId: string;
    turnId: string;
    ownerId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    afterTurnId: string;
    acceptedInput: AcceptedAgentTurnInput;
    maxTurns: number;
    createdAt: string;
}>;

type AcceptedResult = Readonly<{
    conversation: StoredAgentConversation;
    turn: StoredAgentTurn;
}>;

export type AgentConversationAcceptance =
    | (Readonly<{ outcome: "created" | "replayed" }> & AcceptedResult)
    | Readonly<{ outcome: "conflict" }>;

export type AgentTurnAcceptance =
    | (Readonly<{ outcome: "created" | "replayed" }> & AcceptedResult)
    | Readonly<{
          outcome:
              | "busy"
              | "capacity"
              | "conflict"
              | "not_found"
              | "sequence_conflict";
      }>;

export type StartedAgentTurn = Readonly<{
    conversationId: string;
    turnId: string;
    ownerId: string;
    agent: AgentIdentity;
    configRevision: string;
    input: AcceptedAgentTurnInput;
    priorTurns: readonly StoredAgentTurn[];
}>;

export type AgentConversationStore = Readonly<{
    accept: (
        candidate: AcceptedAgentConversation,
    ) => Promise<AgentConversationAcceptance>;
    acceptTurn: (candidate: AcceptedAgentTurn) => Promise<AgentTurnAcceptance>;
    findOwnedMetadata: (
        conversationId: string,
        ownerId: string,
    ) => Promise<StoredAgentConversationMetadata | undefined>;
    findOwnedPage: (request: {
        conversationId: string;
        ownerId: string;
        afterSequence?: number;
        limit: number;
    }) => Promise<StoredAgentConversationPage | undefined>;
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

type IdempotencyRecord = Readonly<{
    fingerprint: string;
    conversationId: string;
    turnId: string;
}>;

export function createInMemoryAgentConversationStore(): AgentConversationStore {
    const conversations = new Map<string, StoredAgentConversation>();
    const conversationIdsByTurn = new Map<string, string>();
    const idempotencyByOwner = new Map<
        string,
        Map<string, IdempotencyRecord>
    >();

    return Object.freeze({
        accept: async (candidate) => {
            const replay = replayFor(
                candidate.ownerId,
                candidate.idempotencyKey,
                candidate.requestFingerprint,
            );
            if (replay) return replay;
            if (conversations.has(candidate.conversationId)) {
                throw new Error("Agent Conversation identity already exists");
            }
            assertFreshTurnId(candidate.turnId);

            const turn: StoredAgentTurn = {
                turnId: candidate.turnId,
                sequence: 1,
                status: "queued",
                input: clone(candidate.acceptedInput),
                createdAt: candidate.createdAt,
            };
            const conversation: StoredAgentConversation = {
                schemaVersion: 1,
                conversationId: candidate.conversationId,
                ownerId: candidate.ownerId,
                agent: clone(candidate.agent),
                configRevision: candidate.configRevision,
                createdAt: candidate.createdAt,
                updatedAt: candidate.createdAt,
                turns: [turn],
            };
            storeAccepted(
                conversation,
                candidate.ownerId,
                candidate.idempotencyKey,
                candidate.requestFingerprint,
                turn,
            );
            return {
                outcome: "created",
                conversation: clone(conversation),
                turn: clone(turn),
            };
        },

        acceptTurn: async (candidate) => {
            const replay = replayFor(
                candidate.ownerId,
                candidate.idempotencyKey,
                candidate.requestFingerprint,
            );
            if (replay) return replay;

            const conversation = conversations.get(candidate.conversationId);
            if (!conversation || conversation.ownerId !== candidate.ownerId) {
                return { outcome: "not_found" };
            }
            if (conversation.turns.some(isActive)) {
                return { outcome: "busy" };
            }
            const lastTurn = conversation.turns.at(-1);
            if (!lastTurn || lastTurn.turnId !== candidate.afterTurnId) {
                return { outcome: "sequence_conflict" };
            }
            if (conversation.turns.length >= candidate.maxTurns) {
                return { outcome: "capacity" };
            }
            assertFreshTurnId(candidate.turnId);

            const turn: StoredAgentTurn = {
                turnId: candidate.turnId,
                sequence: conversation.turns.length + 1,
                status: "queued",
                input: clone(candidate.acceptedInput),
                createdAt: candidate.createdAt,
            };
            const updated = clone({
                ...conversation,
                updatedAt: candidate.createdAt,
                turns: [...conversation.turns, turn],
            });
            storeAccepted(
                updated,
                candidate.ownerId,
                candidate.idempotencyKey,
                candidate.requestFingerprint,
                turn,
            );
            return {
                outcome: "created",
                conversation: clone(updated),
                turn: clone(turn),
            };
        },

        findOwnedMetadata: async (conversationId, ownerId) => {
            const conversation = conversations.get(conversationId);
            return conversation?.ownerId === ownerId
                ? metadata(conversation)
                : undefined;
        },

        findOwnedPage: async (request) => {
            const conversation = conversations.get(request.conversationId);
            if (!conversation || conversation.ownerId !== request.ownerId) {
                return undefined;
            }
            const after = request.afterSequence ?? 0;
            const candidates = conversation.turns.slice(
                after,
                after + request.limit + 1,
            );
            const turns = candidates.slice(0, request.limit);
            const last = turns.at(-1);
            return clone({
                conversation: metadata(conversation),
                turns,
                ...(candidates.length > turns.length && last
                    ? { nextAfterSequence: last.sequence }
                    : {}),
            });
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
                ownerId: conversation.ownerId,
                agent: conversation.agent,
                configRevision: conversation.configRevision,
                input: turn.input,
                priorTurns: conversation.turns.filter(
                    (candidate) => candidate.sequence < turn.sequence,
                ),
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

    function replayFor(
        ownerId: string,
        idempotencyKey: string,
        fingerprint: string,
    ): AgentConversationAcceptance | undefined {
        const record = idempotencyByOwner.get(ownerId)?.get(idempotencyKey);
        if (!record) return undefined;
        if (record.fingerprint !== fingerprint) return { outcome: "conflict" };
        const conversation = conversations.get(record.conversationId);
        const turn = conversation?.turns.find(
            (candidate) => candidate.turnId === record.turnId,
        );
        if (!conversation || !turn) {
            throw new Error(
                "Agent Conversation idempotency index is inconsistent",
            );
        }
        return {
            outcome: "replayed",
            conversation: clone(conversation),
            turn: clone(turn),
        };
    }

    function assertFreshTurnId(turnId: string): void {
        if (conversationIdsByTurn.has(turnId)) {
            throw new Error("Agent Turn identity already exists");
        }
    }

    function storeAccepted(
        conversation: StoredAgentConversation,
        ownerId: string,
        key: string,
        fingerprint: string,
        turn: StoredAgentTurn,
    ): void {
        const ownerKeys = idempotencyByOwner.get(ownerId) ?? new Map();
        ownerKeys.set(key, {
            fingerprint,
            conversationId: conversation.conversationId,
            turnId: turn.turnId,
        });
        idempotencyByOwner.set(ownerId, ownerKeys);
        conversationIdsByTurn.set(turn.turnId, conversation.conversationId);
        conversations.set(conversation.conversationId, clone(conversation));
    }
}

function metadata(
    conversation: StoredAgentConversation,
): StoredAgentConversationMetadata {
    const lastTurn = conversation.turns.at(-1);
    if (!lastTurn) throw new Error("Agent Conversation has no Turns");
    return clone({
        schemaVersion: conversation.schemaVersion,
        conversationId: conversation.conversationId,
        ownerId: conversation.ownerId,
        agent: conversation.agent,
        configRevision: conversation.configRevision,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        turnCount: conversation.turns.length,
        lastTurnId: lastTurn.turnId,
        busy: conversation.turns.some(isActive),
    });
}

function isActive(turn: StoredAgentTurn): boolean {
    return turn.status === "queued" || turn.status === "running";
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
