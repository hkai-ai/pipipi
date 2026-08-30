/** 验证内存 Agent Conversation Store 遵守持久 Adapter 共用契约和闲置期限 */
import { describe, expect, it } from "vitest";
import { createInMemoryAgentConversationStore } from "../src/agent-conversations/store.js";
import {
    acceptedConversation,
    acceptedTurn,
    agentConversationStoreContract,
    timestamp,
} from "./support/agent-conversation-store-contract.js";

agentConversationStoreContract("In-memory", () =>
    createInMemoryAgentConversationStore(),
);

describe("In-memory Agent Conversation retention", () => {
    it("slides on a new Turn and hides an expired idempotent replay", async () => {
        let now = timestamp(0);
        const store = createInMemoryAgentConversationStore({
            retentionMs: 10_000,
            clock: () => now,
        });
        const original = acceptedConversation(10);
        await store.accept(original);
        await store.start({ turnId: original.turnId, startedAt: timestamp(1) });
        await store.complete({
            turnId: original.turnId,
            completedAt: timestamp(2),
            completion: {
                status: "succeeded",
                output: { content: [{ type: "text", text: "done" }] },
            },
        });
        const second = acceptedTurn(original, 2);
        await store.acceptTurn(second);
        await expect(
            store.findOwnedMetadata(original.conversationId, original.ownerId),
        ).resolves.toMatchObject({ expiresAt: timestamp(16) });

        now = timestamp(16);
        await expect(
            store.findOwnedMetadata(original.conversationId, original.ownerId),
        ).resolves.toBeUndefined();
        await expect(
            store.accept({ ...original, createdAt: timestamp(16) }),
        ).resolves.toEqual({ outcome: "deleted" });
    });
});
