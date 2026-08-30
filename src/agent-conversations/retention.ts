/** 驱动 Agent Conversation 分批过期与清理，并支持取消和游标续跑 */
import type {
    AgentConversationCleanupBatchResult,
    PostgresAgentConversationCleanup,
} from "./retention.postgres.js";

export type AgentConversationCleanupSweepResult = Readonly<{
    asOf: string;
    batches: number;
    examined: number;
    expired: number;
    conversationsDeleted: number;
    resourceReferencesDeleted: number;
    completed: boolean;
    nextCursor?: string;
}>;

export type AgentConversationCleaner = Readonly<{
    runSweep: (request?: {
        asOf?: string;
        cursor?: string;
        signal?: AbortSignal;
    }) => Promise<AgentConversationCleanupSweepResult>;
}>;

export function createAgentConversationCleaner(options: {
    cleanup: PostgresAgentConversationCleanup;
    batchSize?: number;
    maximumBatchesPerSweep?: number;
    clock?: () => string;
    onBatch?: (result: AgentConversationCleanupBatchResult) => void;
}): AgentConversationCleaner {
    const batchSize = boundedPositiveInteger(
        options.batchSize ?? 25,
        100,
        "Agent Conversation cleanup batch size",
    );
    const maximumBatchesPerSweep = boundedPositiveInteger(
        options.maximumBatchesPerSweep ?? 100,
        10_000,
        "Agent Conversation cleanup maximum batches per sweep",
    );
    const clock = options.clock ?? (() => new Date().toISOString());
    const onBatch = options.onBatch ?? (() => undefined);

    return Object.freeze({
        runSweep: async (request = {}) => {
            const asOf = request.asOf ?? clock();
            assertTimestamp(asOf);
            let cursor = request.cursor;
            let batches = 0;
            const totals = mutableTotals();

            while (
                batches < maximumBatchesPerSweep &&
                !request.signal?.aborted
            ) {
                const result = await options.cleanup.cleanupBatch({
                    asOf,
                    batchSize,
                    ...(cursor ? { cursor } : {}),
                });
                batches += 1;
                totals.examined += result.examined;
                totals.expired += result.expired;
                totals.conversationsDeleted += result.conversationsDeleted;
                totals.resourceReferencesDeleted +=
                    result.resourceReferencesDeleted;
                onBatch(result);
                cursor = result.nextCursor;
                if (!cursor) {
                    return Object.freeze({
                        asOf,
                        batches,
                        ...totals,
                        completed: true,
                    });
                }
            }

            return Object.freeze({
                asOf,
                batches,
                ...totals,
                completed: cursor === undefined,
                ...(cursor ? { nextCursor: cursor } : {}),
            });
        },
    });
}

type MutableTotals = {
    examined: number;
    expired: number;
    conversationsDeleted: number;
    resourceReferencesDeleted: number;
};

function mutableTotals(): MutableTotals {
    return {
        examined: 0,
        expired: 0,
        conversationsDeleted: 0,
        resourceReferencesDeleted: 0,
    };
}

function boundedPositiveInteger(
    value: number,
    maximum: number,
    label: string,
): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    if (value > maximum) throw new Error(`${label} must not exceed ${maximum}`);
    return value;
}

function assertTimestamp(value: string): void {
    if (!Number.isFinite(new Date(value).getTime())) {
        throw new Error("Agent Conversation cleanup timestamp is invalid");
    }
}
