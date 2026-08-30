/** 验证 Agent Turn Outbox 派发、恢复分类与运行时 readiness */
import { describe, expect, it, vi } from "vitest";
import {
    createAgentTurnDispatcherRuntime,
    createAgentTurnOutboxDispatcher,
} from "../src/agent-conversations/dispatcher.js";
import type { AgentTurnOutbox } from "../src/agent-conversations/outbox.js";
import { createInMemoryAgentTurnQueue } from "../src/agent-conversations/queue.js";
import { createAgentTurnReconciler } from "../src/agent-conversations/recovery.js";

describe("Agent Turn Dispatcher", () => {
    it("acknowledges published messages and releases failed publication", async () => {
        const markPublished = vi.fn(async () => true);
        const release = vi.fn(async () => true);
        const outbox: AgentTurnOutbox = {
            claim: async () => [
                {
                    messageId: "message-1",
                    claimToken: "claim-1",
                    job: { schemaVersion: 1, turnId: "turn-1" },
                },
                {
                    messageId: "message-2",
                    claimToken: "claim-1",
                    job: { schemaVersion: 1, turnId: "turn-2" },
                },
            ],
            markPublished,
            release,
        };
        const dispatcher = createAgentTurnOutboxDispatcher({
            outbox,
            queue: {
                enqueue: async (job) => {
                    if (job.turnId === "turn-2") throw new Error("Redis down");
                    return "enqueued";
                },
                close: async () => {},
            },
            clock: sequenceClock([
                "2026-08-30T08:00:00.000Z",
                "2026-08-30T08:00:01.000Z",
            ]),
            createClaimToken: () => "claim-1",
        });

        await expect(dispatcher.dispatchOnce()).resolves.toEqual({
            claimed: 2,
            published: 1,
            failed: 1,
        });
        expect(markPublished).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledWith({
            messageId: "message-2",
            claimToken: "claim-1",
        });
    });

    it("re-enqueues missing and terminal jobs but defers runnable jobs", async () => {
        const queue = createInMemoryAgentTurnQueue();
        await queue.enqueue({ schemaVersion: 1, turnId: "turn-runnable" });
        const store = {
            findRecoverable: async () => [
                { turnId: "turn-runnable", status: "queued" as const },
                { turnId: "turn-missing", status: "running" as const },
            ],
        };
        const reconciler = createAgentTurnReconciler({
            store,
            queue,
            queuedAgeMs: 1_000,
            clock: () => "2026-08-30T08:01:00.000Z",
        });

        await expect(reconciler.reconcileOnce()).resolves.toEqual({
            found: 2,
            enqueued: 1,
            duplicates: 0,
            deferred: 1,
            failed: 0,
        });
        await expect(
            queue.inspectJobs(["turn-runnable", "turn-missing"]),
        ).resolves.toEqual([
            { turnId: "turn-runnable", state: "runnable" },
            { turnId: "turn-missing", state: "runnable" },
        ]);
    });

    it("reports database and queue readiness and closes resources", async () => {
        const databaseReady = vi.fn(async () => undefined);
        const queueReady = vi.fn(async () => undefined);
        const closeResources = vi.fn(async () => undefined);
        const runtime = createAgentTurnDispatcherRuntime({
            dispatcher: { dispatchOnce: async () => emptyDispatch() },
            reconciler: { reconcileOnce: async () => emptyReconciliation() },
            databaseReady,
            queueReady,
            closeResources,
        });

        await runtime.ready();
        await runtime.close();
        expect(databaseReady).toHaveBeenCalledOnce();
        expect(queueReady).toHaveBeenCalledOnce();
        expect(closeResources).toHaveBeenCalledOnce();
    });
});

function sequenceClock(values: readonly string[]): () => string {
    const remaining = [...values];
    return () => {
        const value = remaining.shift();
        if (!value) throw new Error("Clock exhausted");
        return value;
    };
}

function emptyDispatch() {
    return { claimed: 0, published: 0, failed: 0 };
}

function emptyReconciliation() {
    return {
        found: 0,
        enqueued: 0,
        duplicates: 0,
        deferred: 0,
        failed: 0,
    };
}
