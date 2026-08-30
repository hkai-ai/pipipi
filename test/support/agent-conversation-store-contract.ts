/** 复用 Agent Conversation Store 的创建、幂等、顺序、owner 与终态契约 */
import { describe, expect, it } from "vitest";
import type {
    AcceptedAgentConversation,
    AcceptedAgentTurn,
    AgentConversationStore,
} from "../../src/agent-conversations/store.js";

export function agentConversationStoreContract(
    adapterName: string,
    createStore: () => AgentConversationStore,
): void {
    describe(`${adapterName} Agent Conversation Store contract`, () => {
        it("creates atomically, replays by owner and conflicts on changed input", async () => {
            const store = createStore();
            const original = acceptedConversation(1);

            await expect(store.accept(original)).resolves.toMatchObject({
                outcome: "created",
                conversation: { conversationId: original.conversationId },
                turn: { turnId: original.turnId, sequence: 1 },
            });
            await expect(
                store.accept({
                    ...original,
                    conversationId: "conversation-replay-candidate",
                    turnId: "turn-replay-candidate",
                }),
            ).resolves.toMatchObject({
                outcome: "replayed",
                conversation: { conversationId: original.conversationId },
                turn: { turnId: original.turnId },
            });
            await expect(
                store.accept({
                    ...original,
                    conversationId: "conversation-conflict-candidate",
                    turnId: "turn-conflict-candidate",
                    requestFingerprint: "b".repeat(64),
                }),
            ).resolves.toEqual({ outcome: "conflict" });

            await expect(
                store.findOwnedMetadata(
                    original.conversationId,
                    "another-owner",
                ),
            ).resolves.toBeUndefined();
        });

        it("keeps one active Turn and assigns unique monotonic sequence", async () => {
            const store = createStore();
            const original = acceptedConversation(2);
            await store.accept(original);

            await expect(
                store.acceptTurn(acceptedTurn(original, 2)),
            ).resolves.toEqual({ outcome: "busy" });
            await finishTurn(store, original.turnId, 1);
            await expect(
                store.acceptTurn({
                    ...acceptedTurn(original, 2),
                    afterTurnId: "wrong-turn",
                }),
            ).resolves.toEqual({ outcome: "sequence_conflict" });

            const second = acceptedTurn(original, 2);
            await expect(store.acceptTurn(second)).resolves.toMatchObject({
                outcome: "created",
                turn: { turnId: second.turnId, sequence: 2 },
            });
            await expect(
                store.acceptTurn({
                    ...second,
                    turnId: "turn-replayed-candidate",
                }),
            ).resolves.toMatchObject({
                outcome: "replayed",
                turn: { turnId: second.turnId, sequence: 2 },
            });
            await finishTurn(store, second.turnId, 2);

            const third = acceptedTurn(original, 3);
            await expect(store.acceptTurn(third)).resolves.toMatchObject({
                outcome: "created",
                turn: { sequence: 3 },
            });
            await finishTurn(store, third.turnId, 3);
            await expect(
                store.acceptTurn(acceptedTurn(original, 4, { maxTurns: 3 })),
            ).resolves.toEqual({ outcome: "capacity" });
        });

        it("starts once, stores only public terminal state and paginates", async () => {
            const store = createStore();
            const original = acceptedConversation(3);
            await store.accept(original);
            const started = await store.start({
                turnId: original.turnId,
                startedAt: timestamp(1),
            });
            expect(started).toMatchObject({
                turnId: original.turnId,
                priorTurns: [],
            });
            await expect(
                store.start({
                    turnId: original.turnId,
                    startedAt: timestamp(2),
                }),
            ).resolves.toBeUndefined();
            await expect(
                store.complete({
                    turnId: original.turnId,
                    completedAt: timestamp(2),
                    completion: {
                        status: "succeeded",
                        output: text("public result"),
                    },
                }),
            ).resolves.toBe(true);
            await expect(
                store.complete({
                    turnId: original.turnId,
                    completedAt: timestamp(3),
                    completion: {
                        status: "failed",
                        error: { code: "INTERNAL_ERROR", message: "late" },
                    },
                }),
            ).resolves.toBe(false);

            const second = acceptedTurn(original, 2);
            await store.acceptTurn(second);
            const page = await store.findOwnedPage({
                conversationId: original.conversationId,
                ownerId: original.ownerId,
                limit: 1,
            });
            expect(page).toMatchObject({
                conversation: {
                    turnCount: 2,
                    lastTurnId: second.turnId,
                    busy: true,
                },
                turns: [{ turnId: original.turnId, status: "succeeded" }],
                nextAfterSequence: 1,
            });
            await expect(
                store.findOwnedPage({
                    conversationId: original.conversationId,
                    ownerId: "another-owner",
                    limit: 1,
                }),
            ).resolves.toBeUndefined();
        });

        it("deletes by owner, fences work immediately and replays one deadline", async () => {
            const store = createStore();
            const original = acceptedConversation(4);
            await store.accept(original);

            await expect(
                store.deleteOwned({
                    conversationId: original.conversationId,
                    ownerId: "another-owner",
                    requestedAt: timestamp(1),
                    deleteBy: timestamp(2),
                }),
            ).resolves.toEqual({ outcome: "not_found" });
            const deletion = await store.deleteOwned({
                conversationId: original.conversationId,
                ownerId: original.ownerId,
                requestedAt: timestamp(1),
                deleteBy: timestamp(2),
            });
            expect(deletion).toEqual({
                outcome: "accepted",
                conversationId: original.conversationId,
                deleteBy: timestamp(2),
            });
            await expect(
                store.deleteOwned({
                    conversationId: original.conversationId,
                    ownerId: original.ownerId,
                    requestedAt: timestamp(3),
                    deleteBy: timestamp(4),
                }),
            ).resolves.toEqual({
                outcome: "replayed",
                conversationId: original.conversationId,
                deleteBy: timestamp(2),
            });
            await expect(
                store.findOwnedMetadata(
                    original.conversationId,
                    original.ownerId,
                ),
            ).resolves.toBeUndefined();
            await expect(
                store.start({
                    turnId: original.turnId,
                    startedAt: timestamp(3),
                }),
            ).resolves.toBeUndefined();
            await expect(
                store.acceptTurn(acceptedTurn(original, 2)),
            ).resolves.toEqual({ outcome: "not_found" });
            await expect(store.accept(original)).resolves.toEqual({
                outcome: "deleted",
            });
        });
    });
}

export function acceptedConversation(
    sequence: number,
    overrides: Partial<AcceptedAgentConversation> = {},
): AcceptedAgentConversation {
    return {
        conversationId: `conversation-${sequence}`,
        turnId: `turn-${sequence}-1`,
        ownerId: `owner-${sequence}`,
        idempotencyKey: `open-${sequence}`,
        requestFingerprint: "a".repeat(64),
        agent: { id: "design-assistant", version: "v1" },
        configRevision: "registration-revision-1",
        acceptedInput: text(`message-${sequence}-1`),
        createdAt: timestamp(0),
        ...overrides,
    };
}

export function acceptedTurn(
    conversation: AcceptedAgentConversation,
    sequence: number,
    overrides: Partial<AcceptedAgentTurn> = {},
): AcceptedAgentTurn {
    return {
        conversationId: conversation.conversationId,
        turnId: `turn-${conversation.conversationId}-${sequence}`,
        ownerId: conversation.ownerId,
        idempotencyKey: `continue-${conversation.conversationId}-${sequence}`,
        requestFingerprint: sequence.toString(16).padStart(64, "0"),
        afterTurnId:
            sequence === 2
                ? conversation.turnId
                : `turn-${conversation.conversationId}-${sequence - 1}`,
        acceptedInput: text(`message-${sequence}`),
        maxTurns: 256,
        createdAt: timestamp(sequence * 3),
        ...overrides,
    };
}

export function timestamp(seconds: number): string {
    return new Date(Date.UTC(2026, 7, 30, 8, 0, seconds)).toISOString();
}

function text(value: string) {
    return Object.freeze({
        content: Object.freeze([{ type: "text" as const, text: value }]),
    });
}

async function finishTurn(
    store: AgentConversationStore,
    turnId: string,
    sequence: number,
): Promise<void> {
    const startedAt = timestamp(sequence * 3 + 1);
    const completedAt = timestamp(sequence * 3 + 2);
    const started = await store.start({ turnId, startedAt });
    if (!started) throw new Error("Expected Agent Turn to start");
    const completed = await store.complete({
        turnId,
        completedAt,
        completion: {
            status: "succeeded",
            output: text(`result-${sequence}`),
        },
    });
    if (!completed) throw new Error("Expected Agent Turn to complete");
}
