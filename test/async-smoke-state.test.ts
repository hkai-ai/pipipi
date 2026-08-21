import { describe, expect, it, vi } from "vitest";
import {
    type AsyncSmokeState,
    auditAsyncSmokeState,
    waitForAsyncSmokeDeliveryCoverage,
} from "../src/release/async-smoke-state.js";

describe("Async smoke state audit", () => {
    it("reports only preservation signals and never owner or idempotency values", async () => {
        const query = vi.fn().mockResolvedValue({
            rows: [
                {
                    run_count: 2,
                    terminal_count: 2,
                    owner_count: 2,
                    idempotency_count: 2,
                    event_count: 4,
                    outbox_count: 4,
                    delivery_count: 2,
                    delivery_run_count: 2,
                    schema_count: 8,
                },
            ],
        });
        const runIds = [
            "00000000-0000-4000-8000-000000000301",
            "00000000-0000-4000-8000-000000000302",
        ];

        const evidence = await auditAsyncSmokeState({
            database: { query },
            runIds,
            clock: () => "2026-08-14T10:00:00.000Z",
        });

        expect(evidence).toEqual({
            schemaVersion: 1,
            event: "async_smoke_state_audited",
            measuredAt: "2026-08-14T10:00:00.000Z",
            runIds,
            runs: {
                count: 2,
                terminalCount: 2,
                ownersPresent: true,
                idempotencyPresent: true,
                deliveriesPresent: true,
            },
            processEventCount: 4,
            outboxMessageCount: 4,
            deliveryCount: 2,
            deliveryRunCount: 2,
            additiveSchemaPresent: true,
        });
        expect(JSON.stringify(evidence)).not.toContain("caller-");
        expect(JSON.stringify(evidence)).not.toContain("secret-key");
    });

    it("reports incomplete Delivery coverage when only one controlled Run has a Delivery", async () => {
        const query = vi.fn().mockResolvedValue({
            rows: [
                {
                    run_count: 2,
                    terminal_count: 2,
                    owner_count: 2,
                    idempotency_count: 2,
                    event_count: 4,
                    outbox_count: 4,
                    delivery_count: 3,
                    delivery_run_count: 1,
                    schema_count: 8,
                },
            ],
        });

        const evidence = await auditAsyncSmokeState({
            database: { query },
            runIds: [
                "00000000-0000-4000-8000-000000000301",
                "00000000-0000-4000-8000-000000000302",
            ],
        });

        expect(evidence.runs.deliveriesPresent).toBe(false);
        expect(evidence.deliveryRunCount).toBe(1);
    });

    it("waits through zero and partial Delivery coverage until both Runs are covered", async () => {
        const states = [0, 1, 2].map(deliveryState);
        const read = vi.fn(async () => {
            const state = states.shift();
            if (!state) throw new Error("unexpected read");
            return state;
        });
        const wait = vi.fn(async () => {});

        const state = await waitForAsyncSmokeDeliveryCoverage({
            read,
            maximumAttempts: 3,
            intervalMs: 1,
            wait,
        });

        expect(state.deliveryRunCount).toBe(2);
        expect(read).toHaveBeenCalledTimes(3);
        expect(wait).toHaveBeenCalledTimes(2);
    });
});

function deliveryState(deliveryRunCount: number): AsyncSmokeState {
    return {
        schemaVersion: 1,
        event: "async_smoke_state_audited",
        measuredAt: "2026-08-14T10:00:00.000Z",
        runIds: [
            "00000000-0000-4000-8000-000000000301",
            "00000000-0000-4000-8000-000000000302",
        ],
        runs: {
            count: 2,
            terminalCount: 2,
            ownersPresent: true,
            idempotencyPresent: true,
            deliveriesPresent: deliveryRunCount === 2,
        },
        processEventCount: 4,
        outboxMessageCount: 4,
        deliveryCount: deliveryRunCount,
        deliveryRunCount,
        additiveSchemaPresent: true,
    };
}
