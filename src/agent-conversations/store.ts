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
    expiresAt: string;
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
    | Readonly<{ outcome: "conflict" }>
    | AgentConversationCapacity
    | Readonly<{ outcome: "deleted" }>;

export type AgentTurnAcceptance =
    | (Readonly<{ outcome: "created" | "replayed" }> & AcceptedResult)
    | AgentConversationCapacity
    | Readonly<{
          outcome:
              | "busy"
              | "conflict"
              | "not_found"
              | "sequence_conflict"
              | "turn_limit";
      }>;

export type AgentConversationCapacity = Readonly<{
    outcome: "capacity";
    scope: "caller" | "global";
    retryAfterSeconds: number;
}>;

export type AgentConversationDeletion =
    | Readonly<{
          outcome: "accepted" | "replayed";
          conversationId: string;
          deleteBy: string;
      }>
    | Readonly<{ outcome: "not_found" }>;

export type StartedAgentTurn = Readonly<{
    conversationId: string;
    turnId: string;
    ownerId: string;
    agent: AgentIdentity;
    configRevision: string;
    input: AcceptedAgentTurnInput;
    priorTurns: readonly StoredAgentTurn[];
}>;

export type ClaimedAgentTurn = StartedAgentTurn &
    Readonly<{
        claimToken: string;
        claimExpiresAt: string;
        attemptNumber: number;
        revision: number;
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
    deleteOwned: (request: {
        conversationId: string;
        ownerId: string;
        requestedAt: string;
        deleteBy: string;
    }) => Promise<AgentConversationDeletion>;
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

export type RecoverableAgentConversationStore = AgentConversationStore &
    Readonly<{
        claim: (request: {
            turnId: string;
            claimToken: string;
            claimedAt: string;
        }) => Promise<ClaimedAgentTurn | undefined>;
        completeClaim: (request: {
            turnId: string;
            claimToken: string;
            completedAt: string;
            completion: AgentTurnCompletion;
        }) => Promise<boolean>;
        releaseClaim: (request: {
            turnId: string;
            claimToken: string;
            releasedAt: string;
        }) => Promise<boolean>;
        findRecoverable: (request: {
            asOf: string;
            queuedBefore: string;
            limit: number;
        }) => Promise<
            readonly Readonly<{
                turnId: string;
                status: "queued" | "running";
            }>[]
        >;
    }>;

export function isRecoverableAgentConversationStore(
    store: AgentConversationStore,
): store is RecoverableAgentConversationStore {
    const candidate = store as Partial<RecoverableAgentConversationStore>;
    return (
        typeof candidate.claim === "function" &&
        typeof candidate.completeClaim === "function" &&
        typeof candidate.releaseClaim === "function" &&
        typeof candidate.findRecoverable === "function"
    );
}

type IdempotencyRecord = Readonly<{
    fingerprint: string;
    conversationId: string;
    turnId: string;
}>;

export function createInMemoryAgentConversationStore(
    options: {
        retentionMs?: number;
        clock?: () => string;
        admission?: {
            globalBacklogLimit: number;
            callerBacklogLimit: number;
            retryAfterSeconds: number;
        };
    } = {},
): AgentConversationStore {
    const retentionMs = positiveInteger(
        options.retentionMs ?? 30 * 24 * 60 * 60 * 1_000,
        "Agent Conversation retention",
    );
    const clock = options.clock ?? (() => new Date().toISOString());
    const admission = defineAdmission(options.admission);
    const conversations = new Map<string, StoredAgentConversation>();
    const deleted = new Map<
        string,
        Readonly<{ ownerId: string; deleteBy: string }>
    >();
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
                candidate.createdAt,
            );
            if (replay) return replay;
            if (conversations.has(candidate.conversationId)) {
                throw new Error("Agent Conversation identity already exists");
            }
            const capacity = capacityFor(candidate.ownerId);
            if (capacity) return capacity;
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
                expiresAt: addMilliseconds(candidate.createdAt, retentionMs),
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
                candidate.createdAt,
            );
            if (replay) {
                return replay.outcome === "deleted"
                    ? { outcome: "not_found" }
                    : replay;
            }

            const conversation = activeConversation(
                candidate.conversationId,
                candidate.createdAt,
            );
            if (!conversation || conversation.ownerId !== candidate.ownerId) {
                return { outcome: "not_found" };
            }
            if (conversation.turns.some(isActive)) {
                return { outcome: "busy" };
            }
            const capacity = capacityFor(candidate.ownerId);
            if (capacity) return capacity;
            const lastTurn = conversation.turns.at(-1);
            if (!lastTurn || lastTurn.turnId !== candidate.afterTurnId) {
                return { outcome: "sequence_conflict" };
            }
            if (conversation.turns.length >= candidate.maxTurns) {
                return { outcome: "turn_limit" };
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
                expiresAt: addMilliseconds(candidate.createdAt, retentionMs),
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
            const conversation = activeConversation(conversationId, clock());
            return conversation?.ownerId === ownerId
                ? metadata(conversation)
                : undefined;
        },

        findOwnedPage: async (request) => {
            const conversation = activeConversation(
                request.conversationId,
                clock(),
            );
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

        deleteOwned: async (request) => {
            assertDeletionWindow(request.requestedAt, request.deleteBy);
            const tombstone = deleted.get(request.conversationId);
            if (tombstone) {
                return tombstone.ownerId === request.ownerId
                    ? {
                          outcome: "replayed",
                          conversationId: request.conversationId,
                          deleteBy: tombstone.deleteBy,
                      }
                    : { outcome: "not_found" };
            }
            const conversation = activeConversation(
                request.conversationId,
                request.requestedAt,
            );
            if (!conversation || conversation.ownerId !== request.ownerId) {
                return { outcome: "not_found" };
            }
            purgeConversation(conversation);
            deleted.set(request.conversationId, {
                ownerId: request.ownerId,
                deleteBy: request.deleteBy,
            });
            return {
                outcome: "accepted",
                conversationId: request.conversationId,
                deleteBy: request.deleteBy,
            };
        },

        start: async (request) => {
            const conversationId = conversationIdsByTurn.get(request.turnId);
            const conversation = conversationId
                ? activeConversation(conversationId, request.startedAt)
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
                ? activeConversation(conversationId, request.completedAt)
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
        asOf: string,
    ): AgentConversationAcceptance | undefined {
        const record = idempotencyByOwner.get(ownerId)?.get(idempotencyKey);
        if (!record) return undefined;
        if (record.fingerprint !== fingerprint) return { outcome: "conflict" };
        const conversation = activeConversation(record.conversationId, asOf);
        const turn = conversation?.turns.find(
            (candidate) => candidate.turnId === record.turnId,
        );
        if (!conversation || !turn) {
            if (deleted.has(record.conversationId)) {
                return { outcome: "deleted" };
            }
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

    function activeConversation(
        conversationId: string,
        asOf: string,
    ): StoredAgentConversation | undefined {
        const conversation = conversations.get(conversationId);
        if (!conversation) return undefined;
        if (
            timestampMilliseconds(conversation.expiresAt) >
            timestampMilliseconds(asOf)
        ) {
            return conversation;
        }
        purgeConversation(conversation);
        deleted.set(conversationId, {
            ownerId: conversation.ownerId,
            deleteBy: conversation.expiresAt,
        });
        return undefined;
    }

    function purgeConversation(conversation: StoredAgentConversation): void {
        conversations.delete(conversation.conversationId);
        for (const turn of conversation.turns) {
            conversationIdsByTurn.delete(turn.turnId);
        }
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

    function capacityFor(
        ownerId: string,
    ): AgentConversationCapacity | undefined {
        if (!admission) return undefined;
        let global = 0;
        let caller = 0;
        for (const conversation of conversations.values()) {
            if (!conversation.turns.some(isActive)) continue;
            global += 1;
            if (conversation.ownerId === ownerId) caller += 1;
        }
        return caller >= admission.callerBacklogLimit
            ? {
                  outcome: "capacity",
                  scope: "caller",
                  retryAfterSeconds: admission.retryAfterSeconds,
              }
            : global >= admission.globalBacklogLimit
              ? {
                    outcome: "capacity",
                    scope: "global",
                    retryAfterSeconds: admission.retryAfterSeconds,
                }
              : undefined;
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
        expiresAt: conversation.expiresAt,
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

function addMilliseconds(timestamp: string, durationMs: number): string {
    const value = timestampMilliseconds(timestamp);
    return new Date(value + durationMs).toISOString();
}

function timestampMilliseconds(timestamp: string): number {
    const value = new Date(timestamp).getTime();
    if (!Number.isFinite(value)) {
        throw new Error("Agent Conversation timestamp is invalid");
    }
    return value;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function defineAdmission(
    admission:
        | {
              globalBacklogLimit: number;
              callerBacklogLimit: number;
              retryAfterSeconds: number;
          }
        | undefined,
) {
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

function assertDeletionWindow(requestedAt: string, deleteBy: string): void {
    const requested = new Date(requestedAt).getTime();
    const deadline = new Date(deleteBy).getTime();
    if (
        !Number.isFinite(requested) ||
        !Number.isFinite(deadline) ||
        deadline < requested ||
        deadline - requested > 24 * 60 * 60 * 1_000
    ) {
        throw new Error(
            "Agent Conversation deleteBy must be within 24 hours of requestedAt",
        );
    }
}
