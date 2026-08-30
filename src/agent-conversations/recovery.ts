/** 从 PostgreSQL 权威 Turn 恢复 Redis 中缺失、终态或损坏的 Agent Turn Job */
import type { RecoverableAgentTurnQueue } from "./queue.js";
import type { RecoverableAgentConversationStore } from "./store.js";

export type AgentTurnReconciliationResult = Readonly<{
    found: number;
    enqueued: number;
    duplicates: number;
    deferred: number;
    failed: number;
}>;

export type AgentTurnReconciler = Readonly<{
    reconcileOnce: () => Promise<AgentTurnReconciliationResult>;
}>;

export function createAgentTurnReconciler(options: {
    store: Pick<RecoverableAgentConversationStore, "findRecoverable">;
    queue: RecoverableAgentTurnQueue;
    queuedAgeMs?: number;
    batchSize?: number;
    clock?: () => string;
}): AgentTurnReconciler {
    const queuedAgeMs = positiveInteger(
        options.queuedAgeMs ?? 60_000,
        "Queued Agent Turn recovery age",
    );
    const batchSize = positiveInteger(
        options.batchSize ?? 25,
        "Agent Turn recovery batch size",
    );
    if (batchSize > 100) {
        throw new Error("Agent Turn recovery batch size must not exceed 100");
    }
    const clock = options.clock ?? (() => new Date().toISOString());

    return Object.freeze({
        reconcileOnce: async () => {
            const asOf = clock();
            const candidates = await options.store.findRecoverable({
                asOf,
                queuedBefore: subtractMilliseconds(asOf, queuedAgeMs),
                limit: batchSize,
            });
            if (candidates.length === 0) return emptyResult();
            const inspections = await options.queue.inspectJobs(
                candidates.map((candidate) => candidate.turnId),
            );
            const byTurn = new Map(
                inspections.map((inspection) => [
                    inspection.turnId,
                    inspection.state,
                ]),
            );
            let enqueued = 0;
            let duplicates = 0;
            let deferred = 0;
            let failed = 0;
            for (const candidate of candidates) {
                const state = byTurn.get(candidate.turnId);
                if (!state)
                    throw new Error(
                        "Agent Turn Queue inspection is incomplete",
                    );
                if (state === "runnable") {
                    deferred += 1;
                    continue;
                }
                try {
                    const outcome = await options.queue.enqueue({
                        schemaVersion: 1,
                        turnId: candidate.turnId,
                    });
                    if (outcome === "enqueued") enqueued += 1;
                    else duplicates += 1;
                } catch {
                    failed += 1;
                }
            }
            return Object.freeze({
                found: candidates.length,
                enqueued,
                duplicates,
                deferred,
                failed,
            });
        },
    });
}

function emptyResult(): AgentTurnReconciliationResult {
    return Object.freeze({
        found: 0,
        enqueued: 0,
        duplicates: 0,
        deferred: 0,
        failed: 0,
    });
}

function subtractMilliseconds(timestamp: string, durationMs: number): string {
    const value = new Date(timestamp).getTime();
    if (!Number.isFinite(value))
        throw new Error("Agent Turn timestamp is invalid");
    return new Date(value - durationMs).toISOString();
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}
