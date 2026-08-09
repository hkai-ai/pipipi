import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { constructAsyncOperationsCommand } from "../src/app/async-operations.js";
import {
    createPostgresAsyncOperations,
    createPostgresAsyncReleaseReadiness,
} from "../src/process-runs/ops/index.js";
import { readBullMqQueueSnapshot } from "../src/process-runs/queue/observability.js";

describe("Async operations observability", () => {
    it("normalizes PostgreSQL operational metrics without content fields", async () => {
        const pool = {
            query: vi.fn().mockResolvedValue({
                rows: [operationalRow()],
            }),
        } as unknown as Pool;
        const operations = createPostgresAsyncOperations({
            pool,
            recentWindowMs: 300_000,
            stuckRunAgeMs: 60_000,
        });

        const snapshot = await operations.snapshot({
            asOf: "2026-08-09T10:05:00.000Z",
        });

        expect(snapshot).toEqual({
            schemaVersion: 1,
            measuredAt: "2026-08-09T10:05:00.000Z",
            runs: {
                queued: 3,
                running: 2,
                succeededRecent: 8,
                failedRecent: 2,
                failureRateRecent: 0.2,
                oldestQueuedAgeMs: 90_000,
                queueWaitP95Ms: 1_500,
                executionP95Ms: 12_000,
                stuck: 2,
            },
            outbox: {
                processPending: 4,
                webhookPending: 5,
                oldestProcessLagMs: 2_000,
                oldestWebhookLagMs: 3_000,
            },
            webhooks: {
                pending: 5,
                delivering: 1,
                succeededRecent: 7,
                failedRecent: 1,
                exhaustedRecent: 2,
                failureRateRecent: 0.3,
                oldestPendingAgeMs: 3_000,
            },
            cleanup: {
                lastCompletedAt: "2026-08-09T10:04:00.000Z",
                lastDeferredRuns: 1,
            },
            recovery: {
                lastCompletedAt: "2026-08-09T10:03:00.000Z",
                lastStatus: "completed",
                lastMissingJobs: 2,
                lastFailedItems: 0,
            },
            storage: { databaseBytes: 1_000_000, asyncTablesBytes: 250_000 },
        });
        expect(JSON.stringify(snapshot)).not.toContain("accepted_input");
        expect(JSON.stringify(snapshot)).not.toContain("payload");
    });

    it("reads bounded BullMQ counts and oldest runnable age", async () => {
        const queue = {
            getJobCounts: vi.fn().mockResolvedValue({
                waiting: 4,
                active: 2,
                delayed: 1,
                prioritized: 0,
                failed: 3,
                completed: 9,
                "waiting-children": 0,
            }),
            getJobs: vi
                .fn()
                .mockResolvedValue([
                    { timestamp: 6_000 },
                    { timestamp: 1_000 },
                ]),
        };

        await expect(readBullMqQueueSnapshot(queue, 11_000)).resolves.toEqual({
            waiting: 4,
            active: 2,
            delayed: 1,
            prioritized: 0,
            failed: 3,
            completed: 9,
            waitingChildren: 0,
            oldestRunnableAgeMs: 10_000,
        });
        expect(queue.getJobs).toHaveBeenCalledWith(
            ["waiting", "active", "delayed", "prioritized", "waiting-children"],
            0,
            0,
            true,
        );
    });

    it("holds canary readiness until capacity, lag, stuck, and recovery gates pass", async () => {
        const pool = {
            query: vi
                .fn()
                .mockResolvedValueOnce({
                    rows: [{ backlog: 9, stuck: 0, oldest_outbox_lag_ms: 10 }],
                })
                .mockResolvedValueOnce({
                    rows: [
                        {
                            backlog: 1,
                            stuck: 0,
                            oldest_outbox_lag_ms: 10,
                            recovery_completed_at: new Date(
                                "2026-08-09T10:04:00.000Z",
                            ),
                            recovery_failed_count: 0,
                            recovery_incomplete_count: 0,
                            recovery_finished: false,
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    rows: [
                        {
                            backlog: 1,
                            stuck: 0,
                            oldest_outbox_lag_ms: 10,
                            recovery_completed_at: new Date(
                                "2026-08-09T10:04:00.000Z",
                            ),
                            recovery_failed_count: 0,
                            recovery_incomplete_count: 0,
                            recovery_finished: true,
                        },
                    ],
                }),
        } as unknown as Pool;
        const readiness = createPostgresAsyncReleaseReadiness({
            pool,
            stage: "canary",
            globalBacklogLimit: 9,
            stuckRunAgeMs: 60_000,
            maximumStuckRuns: 0,
            maximumOutboxLagMs: 30_000,
            recoveryMaxAgeMs: 300_000,
            clock: () => "2026-08-09T10:05:00.000Z",
        });

        await expect(readiness()).rejects.toThrow("capacity gate");
        await expect(readiness()).rejects.toThrow("recovery gate");
        await expect(readiness()).resolves.toBeUndefined();
    });

    it("lets the internal stage validate dependencies without production gates", async () => {
        const query = vi.fn();
        const readiness = createPostgresAsyncReleaseReadiness({
            pool: { query } as unknown as Pool,
            stage: "internal",
            globalBacklogLimit: 10,
            stuckRunAgeMs: 60_000,
            maximumStuckRuns: 0,
            maximumOutboxLagMs: 30_000,
            recoveryMaxAgeMs: 300_000,
        });

        await expect(readiness()).resolves.toBeUndefined();
        expect(query).not.toHaveBeenCalled();
    });

    it("constructs the one-shot observer from database and queue-owned settings", async () => {
        expect(() => constructAsyncOperationsCommand({})).toThrow(
            "DATABASE_URL is required for Async Operations",
        );
        expect(() =>
            constructAsyncOperationsCommand({
                DATABASE_URL:
                    "postgres://service:local@127.0.0.1:55432/pipipi_test",
            }),
        ).toThrow("REDIS_URL is required for Async Operations");
        expect(() =>
            constructAsyncOperationsCommand({
                DATABASE_URL:
                    "postgres://service:local@127.0.0.1:55432/pipipi_test",
                REDIS_URL: "redis://127.0.0.1:56379/15",
                ASYNC_OPERATIONS_RECENT_WINDOW_MS: "0",
            }),
        ).toThrow(
            "ASYNC_OPERATIONS_RECENT_WINDOW_MS must be a positive integer",
        );

        const command = constructAsyncOperationsCommand({
            DATABASE_URL:
                "postgres://service:local@127.0.0.1:55432/pipipi_test",
            REDIS_URL: "redis://127.0.0.1:56379/15",
        });
        await command.close();
        await command.close();
    });
});

function operationalRow() {
    return {
        queued_runs: 3,
        running_runs: 2,
        succeeded_recent: 8,
        failed_recent: 2,
        oldest_queued_age_ms: 90_000,
        queue_wait_p95_ms: 1_500,
        execution_p95_ms: 12_000,
        stuck_runs: 2,
        process_outbox_pending: 4,
        webhook_outbox_pending: 5,
        oldest_process_outbox_lag_ms: 2_000,
        oldest_webhook_outbox_lag_ms: 3_000,
        webhook_pending: 5,
        webhook_delivering: 1,
        webhook_succeeded_recent: 7,
        webhook_failed_recent: 1,
        webhook_exhausted_recent: 2,
        oldest_webhook_pending_age_ms: 3_000,
        cleanup_completed_at: new Date("2026-08-09T10:04:00.000Z"),
        cleanup_deferred_runs: 1,
        recovery_completed_at: new Date("2026-08-09T10:03:00.000Z"),
        recovery_status: "completed",
        recovery_missing_jobs: 2,
        recovery_failed_items: 0,
        database_bytes: "1000000",
        async_tables_bytes: "250000",
    };
}
