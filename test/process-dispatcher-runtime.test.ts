import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessDispatcherRuntime } from "../src/process-runs/dispatcher.js";
import type { OutboxDispatcher } from "../src/process-runs/outbox/dispatcher.js";
import type { ProcessRunReconciler } from "../src/process-runs/recovery/index.js";

afterEach(() => {
    vi.useRealTimers();
});

describe("Process Dispatcher Runtime", () => {
    it("runs both coordinators without blocking startup and checks both dependencies", async () => {
        vi.useFakeTimers();
        const dispatchOnce = vi.fn(async () => ({
            claimed: 0,
            published: 0,
            failed: 0,
        }));
        const reconcileOnce = vi.fn(async () => ({
            found: 0,
            enqueued: 0,
            duplicates: 0,
            failed: 0,
        }));
        const databaseReady = vi.fn(async () => undefined);
        const queueReady = vi.fn(async () => undefined);
        const closeResources = vi.fn(async () => undefined);
        const runtime = createProcessDispatcherRuntime({
            dispatcher: { dispatchOnce },
            reconciler: { reconcileOnce },
            databaseReady,
            queueReady,
            closeResources,
            dispatchIntervalMs: 100,
            reconciliationIntervalMs: 500,
        });

        await runtime.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(dispatchOnce).toHaveBeenCalledOnce();
        expect(reconcileOnce).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(500);
        expect(dispatchOnce).toHaveBeenCalledTimes(6);
        expect(reconcileOnce).toHaveBeenCalledTimes(2);
        await runtime.ready();
        expect(databaseReady).toHaveBeenCalledOnce();
        expect(queueReady).toHaveBeenCalledOnce();

        await runtime.close();
        await runtime.close();
        expect(closeResources).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(dispatchOnce).toHaveBeenCalledTimes(6);
        expect(reconcileOnce).toHaveBeenCalledTimes(2);
    });

    it("reports an operation failure and keeps its loop alive", async () => {
        vi.useFakeTimers();
        const dispatchOnce = vi
            .fn<OutboxDispatcher["dispatchOnce"]>()
            .mockRejectedValueOnce(new Error("postgres://secret unavailable"))
            .mockResolvedValue({ claimed: 0, published: 0, failed: 0 });
        const onError = vi.fn();
        const runtime = createProcessDispatcherRuntime({
            dispatcher: { dispatchOnce },
            reconciler: idleReconciler(),
            databaseReady: async () => undefined,
            queueReady: async () => undefined,
            closeResources: async () => undefined,
            dispatchIntervalMs: 100,
            reconciliationIntervalMs: 1_000,
            onError,
        });

        await runtime.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(onError).toHaveBeenCalledWith("outbox_dispatch");
        await vi.advanceTimersByTimeAsync(100);
        expect(dispatchOnce).toHaveBeenCalledTimes(2);
        await runtime.close();
    });

    it("validates intervals before starting", () => {
        expect(() =>
            createProcessDispatcherRuntime({
                dispatcher: idleDispatcher(),
                reconciler: idleReconciler(),
                databaseReady: async () => undefined,
                queueReady: async () => undefined,
                closeResources: async () => undefined,
                dispatchIntervalMs: 0,
            }),
        ).toThrow("Outbox dispatch interval must be a positive safe integer");
    });
});

function idleDispatcher(): OutboxDispatcher {
    return {
        dispatchOnce: async () => ({ claimed: 0, published: 0, failed: 0 }),
    };
}

function idleReconciler(): Pick<ProcessRunReconciler, "reconcileOnce"> {
    return {
        reconcileOnce: async () => ({
            found: 0,
            enqueued: 0,
            duplicates: 0,
            failed: 0,
        }),
    };
}
