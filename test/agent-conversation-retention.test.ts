/** 验证 Agent Conversation Cleaner 的有界批次、取消和游标续跑 */
import { describe, expect, it, vi } from "vitest";
import { createAgentConversationCleaner } from "../src/agent-conversations/retention.js";
import type { PostgresAgentConversationCleanup } from "../src/agent-conversations/retention.postgres.js";

describe("Agent Conversation Cleaner", () => {
    it("returns a continuation cursor and resumes with the same deadline", async () => {
        const cleanupBatch = vi
            .fn<PostgresAgentConversationCleanup["cleanupBatch"]>()
            .mockResolvedValueOnce(
                batch({
                    cleanupId: "cleanup-1",
                    examined: 2,
                    expired: 1,
                    nextCursor: "conversation-2",
                }),
            )
            .mockResolvedValueOnce(
                batch({
                    cleanupId: "cleanup-2",
                    examined: 1,
                    conversationsDeleted: 1,
                    resourceReferencesDeleted: 2,
                }),
            );
        const cleaner = createAgentConversationCleaner({
            cleanup: { cleanupBatch, ready: async () => undefined },
            batchSize: 2,
            maximumBatchesPerSweep: 1,
        });
        const asOf = "2026-08-30T08:00:00.000Z";

        const first = await cleaner.runSweep({ asOf });
        expect(first).toEqual({
            asOf,
            batches: 1,
            examined: 2,
            expired: 1,
            conversationsDeleted: 0,
            resourceReferencesDeleted: 0,
            completed: false,
            nextCursor: "conversation-2",
        });
        await expect(
            cleaner.runSweep({ asOf, cursor: first.nextCursor }),
        ).resolves.toEqual({
            asOf,
            batches: 1,
            examined: 1,
            expired: 0,
            conversationsDeleted: 1,
            resourceReferencesDeleted: 2,
            completed: true,
        });
        expect(cleanupBatch.mock.calls).toEqual([
            [{ asOf, batchSize: 2 }],
            [{ asOf, batchSize: 2, cursor: "conversation-2" }],
        ]);
    });

    it("stops between transactions when cancelled and preserves continuation", async () => {
        const controller = new AbortController();
        const cleanupBatch = vi
            .fn<PostgresAgentConversationCleanup["cleanupBatch"]>()
            .mockResolvedValue(
                batch({ examined: 1, nextCursor: "conversation-1" }),
            );
        const cleaner = createAgentConversationCleaner({
            cleanup: { cleanupBatch, ready: async () => undefined },
            onBatch: () => controller.abort(),
        });

        await expect(
            cleaner.runSweep({
                asOf: "2026-08-30T08:00:00.000Z",
                signal: controller.signal,
            }),
        ).resolves.toMatchObject({
            batches: 1,
            completed: false,
            nextCursor: "conversation-1",
        });
        expect(cleanupBatch).toHaveBeenCalledOnce();
    });
});

function batch(
    overrides: Partial<
        Awaited<ReturnType<PostgresAgentConversationCleanup["cleanupBatch"]>>
    >,
) {
    return {
        examined: 0,
        expired: 0,
        conversationsDeleted: 0,
        resourceReferencesDeleted: 0,
        ...overrides,
    };
}
