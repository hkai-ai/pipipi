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

export type AgentConversationCleanerRuntime = Readonly<{
    start: () => Promise<void>;
    ready: () => Promise<void>;
    close: () => Promise<void>;
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

export function createAgentConversationCleanerRuntime(options: {
    cleaner: AgentConversationCleaner;
    databaseReady: () => Promise<void>;
    closeResources: () => Promise<void>;
    intervalMs?: number;
}): AgentConversationCleanerRuntime {
    const intervalMs = boundedPositiveInteger(
        options.intervalMs ?? 3_600_000,
        86_400_000,
        "Agent Conversation cleanup interval",
    );
    let current: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let controller: AbortController | undefined;
    let continuation: Readonly<{ asOf: string; cursor: string }> | undefined;
    let closed = false;
    const run = () => {
        if (closed || current) return;
        controller = new AbortController();
        current = options.cleaner
            .runSweep({
                ...(continuation ?? {}),
                signal: controller.signal,
            })
            .then((result) => {
                continuation = result.nextCursor
                    ? { asOf: result.asOf, cursor: result.nextCursor }
                    : undefined;
                console.log(
                    JSON.stringify({
                        event: "agent_conversation_cleanup_completed",
                        ...result,
                        timestamp: new Date().toISOString(),
                    }),
                );
            })
            .catch(() => {
                console.error(
                    JSON.stringify({
                        event: "agent_conversation_cleanup_failed",
                        timestamp: new Date().toISOString(),
                    }),
                );
            })
            .finally(() => {
                current = undefined;
                controller = undefined;
                if (!closed) timer = setTimeout(run, intervalMs);
            });
    };
    return Object.freeze({
        start: async () => run(),
        ready: options.databaseReady,
        close: async () => {
            if (closed) return;
            closed = true;
            if (timer) clearTimeout(timer);
            controller?.abort();
            try {
                await current;
            } finally {
                await options.closeResources();
            }
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
