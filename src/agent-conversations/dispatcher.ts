/** 派发 Agent Turn Outbox，并周期恢复缺失或租期过期的最小 Queue Job */
import { randomUUID } from "node:crypto";
import type { AgentTurnOutbox } from "./outbox.js";
import type { AgentTurnQueue } from "./queue.js";
import type { AgentTurnReconciler } from "./recovery.js";

export type AgentTurnDispatchResult = Readonly<{
    claimed: number;
    published: number;
    failed: number;
}>;

export type AgentTurnOutboxDispatcher = Readonly<{
    dispatchOnce: () => Promise<AgentTurnDispatchResult>;
}>;

export function createAgentTurnOutboxDispatcher(options: {
    outbox: AgentTurnOutbox;
    queue: AgentTurnQueue;
    batchSize?: number;
    claimLeaseMs?: number;
    clock?: () => string;
    createClaimToken?: () => string;
}): AgentTurnOutboxDispatcher {
    const batchSize = boundedBatchSize(options.batchSize ?? 25);
    const claimLeaseMs = positiveInteger(
        options.claimLeaseMs ?? 30_000,
        "Agent Turn Outbox claim lease",
    );
    const clock = options.clock ?? (() => new Date().toISOString());
    const createClaimToken = options.createClaimToken ?? randomUUID;

    return Object.freeze({
        dispatchOnce: async () => {
            const claimedAt = clock();
            const messages = await options.outbox.claim({
                limit: batchSize,
                claimToken: createClaimToken(),
                claimedAt,
                claimExpiresAt: addMilliseconds(claimedAt, claimLeaseMs),
            });
            let published = 0;
            let failed = 0;
            for (const message of messages) {
                try {
                    await options.queue.enqueue(message.job);
                    const marked = await options.outbox.markPublished({
                        messageId: message.messageId,
                        claimToken: message.claimToken,
                        publishedAt: clock(),
                    });
                    if (!marked)
                        throw new Error("Agent Turn Outbox claim was lost");
                    published += 1;
                } catch {
                    failed += 1;
                    await options.outbox.release({
                        messageId: message.messageId,
                        claimToken: message.claimToken,
                    });
                }
            }
            return Object.freeze({
                claimed: messages.length,
                published,
                failed,
            });
        },
    });
}

export type AgentTurnDispatcherRuntime = Readonly<{
    start: () => Promise<void>;
    ready: () => Promise<void>;
    close: () => Promise<void>;
}>;

export function createAgentTurnDispatcherRuntime(options: {
    dispatcher: AgentTurnOutboxDispatcher;
    reconciler: AgentTurnReconciler;
    databaseReady: () => Promise<void>;
    queueReady: () => Promise<void>;
    closeResources: () => Promise<void>;
    dispatchIntervalMs?: number;
    reconciliationIntervalMs?: number;
    onError?: (operation: "outbox_dispatch" | "turn_reconciliation") => void;
}): AgentTurnDispatcherRuntime {
    const onError = options.onError ?? reportRuntimeError;
    const dispatch = periodicLoop(
        () => options.dispatcher.dispatchOnce(),
        options.dispatchIntervalMs ?? 1_000,
        () => onError("outbox_dispatch"),
    );
    const reconcile = periodicLoop(
        () => options.reconciler.reconcileOnce(),
        options.reconciliationIntervalMs ?? 30_000,
        () => onError("turn_reconciliation"),
    );
    let started = false;
    let closed = false;
    return Object.freeze({
        start: async () => {
            if (closed) throw new Error("Agent Turn Dispatcher is closed");
            if (started) return;
            started = true;
            dispatch.start();
            reconcile.start();
        },
        ready: async () => {
            await Promise.all([options.databaseReady(), options.queueReady()]);
        },
        close: async () => {
            if (closed) return;
            closed = true;
            try {
                await Promise.all([dispatch.close(), reconcile.close()]);
            } finally {
                await options.closeResources();
            }
        },
    });
}

function periodicLoop(
    operation: () => Promise<unknown>,
    intervalMs: number,
    onError: () => void,
): Readonly<{ start: () => void; close: () => Promise<void> }> {
    positiveInteger(intervalMs, "Agent Turn Dispatcher interval");
    let current: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const run = () => {
        if (stopped || current) return;
        current = operation()
            .then(() => undefined)
            .catch(() => onError())
            .finally(() => {
                current = undefined;
                if (!stopped) timer = setTimeout(run, intervalMs);
            });
    };
    return Object.freeze({
        start: run,
        close: async () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            await current;
        },
    });
}

function addMilliseconds(timestamp: string, durationMs: number): string {
    const value = new Date(timestamp).getTime();
    if (!Number.isFinite(value))
        throw new Error("Agent Turn timestamp is invalid");
    return new Date(value + durationMs).toISOString();
}

function boundedBatchSize(value: number): number {
    const size = positiveInteger(value, "Agent Turn Outbox batch size");
    if (size > 100)
        throw new Error("Agent Turn Outbox batch size must not exceed 100");
    return size;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function reportRuntimeError(
    operation: "outbox_dispatch" | "turn_reconciliation",
): void {
    console.error(
        JSON.stringify({
            event: "agent_turn_dispatcher_error",
            operation,
            timestamp: new Date().toISOString(),
        }),
    );
}
