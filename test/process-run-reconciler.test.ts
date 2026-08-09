import { describe, expect, it, vi } from "vitest";
import type { RecoverableProcessWorkQueue } from "../src/runs/queue.js";
import {
    createProcessRunReconciler,
    type ProcessRecoveryCandidate,
    type ProcessRecoveryStore,
} from "../src/runs/recovery.js";

describe("Process Run Reconciler", () => {
    it("repairs missing jobs and pending outbox while deferring an active lease", async () => {
        const candidates: ProcessRecoveryCandidate[] = [
            candidate(1, "queued", "recent_queued", true),
            candidate(2, "queued", "stuck_queued", true),
            candidate(3, "running", "expired_lease", false),
            candidate(4, "running", "active_lease", true),
        ];
        const acknowledgePendingOutbox = vi.fn(async () => 1);
        const recordRecoveryItem = vi.fn(async () => undefined);
        const completeRecovery = vi.fn(async () => undefined);
        const enqueue = vi
            .fn<RecoverableProcessWorkQueue["enqueue"]>()
            .mockResolvedValueOnce("enqueued")
            .mockResolvedValueOnce("duplicate");
        const reconciler = createProcessRunReconciler({
            store: fakeStore({
                findRecoveryCandidates: async () => ({ candidates }),
                acknowledgePendingOutbox,
                recordRecoveryItem,
                completeRecovery,
            }),
            queue: fakeQueue({
                enqueue,
                inspectJobs: async () => [
                    { runId: runId(1), state: "missing" },
                    { runId: runId(2), state: "runnable" },
                    { runId: runId(3), state: "terminal" },
                    { runId: runId(4), state: "missing" },
                ],
            }),
            queuedAgeMs: 60_000,
            batchSize: 10,
            clock: () => AS_OF,
            createRecoveryId: () => RECOVERY_ID,
        });

        const report = await reconciler.recover({
            trigger: "manual",
            mode: "all",
            dryRun: false,
            actorId: "operator:recovery",
            asOf: AS_OF,
        });
        expect(report).toMatchObject({
            recoveryId: RECOVERY_ID,
            found: 4,
            missingJobs: 2,
            existingJobs: 1,
            terminalJobs: 1,
            activeLeases: 1,
            pendingOutbox: 3,
            enqueued: 1,
            duplicates: 1,
            outboxAcknowledged: 2,
            failed: 0,
        });
        expect(report.items).toEqual([
            expect.objectContaining({
                runId: runId(1),
                action: "enqueued",
                outboxAction: "acknowledged",
            }),
            expect.objectContaining({
                runId: runId(2),
                action: "none",
                outboxAction: "acknowledged",
            }),
            expect.objectContaining({
                runId: runId(3),
                action: "duplicate",
                outboxAction: "none",
            }),
            expect.objectContaining({
                runId: runId(4),
                action: "deferred",
                outboxAction: "none",
            }),
        ]);
        expect(enqueue.mock.calls).toEqual([
            [{ schemaVersion: 1, runId: runId(1) }],
            [{ schemaVersion: 1, runId: runId(3) }],
        ]);
        expect(acknowledgePendingOutbox).toHaveBeenCalledTimes(2);
        expect(recordRecoveryItem).toHaveBeenCalledTimes(4);
        expect(completeRecovery).toHaveBeenCalledWith(
            expect.objectContaining({
                recoveryId: RECOVERY_ID,
                counters: expect.objectContaining({ found: 4, enqueued: 1 }),
            }),
        );
    });

    it("reports a dry-run without mutating the queue or outbox", async () => {
        const enqueue = vi.fn<RecoverableProcessWorkQueue["enqueue"]>();
        const acknowledgePendingOutbox = vi.fn(async () => 1);
        const store = fakeStore({
            findRecoveryCandidates: async () => ({
                candidates: [candidate(5, "queued", "recent_queued", true)],
                nextCursor: runId(5),
            }),
            acknowledgePendingOutbox,
        });
        const reconciler = createProcessRunReconciler({
            store,
            queue: fakeQueue({
                enqueue,
                inspectJobs: async () => [
                    { runId: runId(5), state: "missing" },
                ],
            }),
            clock: () => AS_OF,
            createRecoveryId: () => RECOVERY_ID,
        });

        await expect(
            reconciler.recover({
                trigger: "manual",
                mode: "all",
                dryRun: true,
                actorId: "operator:dry-run",
            }),
        ).resolves.toMatchObject({
            dryRun: true,
            missingJobs: 1,
            enqueued: 0,
            outboxAcknowledged: 0,
            nextCursor: runId(5),
            items: [
                expect.objectContaining({
                    action: "would_enqueue",
                    outboxAction: "would_acknowledge",
                }),
            ],
        });
        expect(enqueue).not.toHaveBeenCalled();
        expect(acknowledgePendingOutbox).not.toHaveBeenCalled();
    });

    it("isolates one queue failure and audits the remaining batch", async () => {
        const recordRecoveryItem = vi.fn(async () => undefined);
        const reconciler = createProcessRunReconciler({
            store: fakeStore({
                findRecoveryCandidates: async () => ({
                    candidates: [
                        candidate(6, "queued", "stuck_queued", false),
                        candidate(7, "queued", "stuck_queued", false),
                    ],
                }),
                recordRecoveryItem,
            }),
            queue: fakeQueue({
                inspectJobs: async () => [
                    { runId: runId(6), state: "missing" },
                    { runId: runId(7), state: "missing" },
                ],
                enqueue: async (job) => {
                    if (job.runId === runId(6))
                        throw new Error("Redis unavailable");
                    return "enqueued";
                },
            }),
            clock: () => AS_OF,
            createRecoveryId: () => RECOVERY_ID,
        });

        await expect(
            reconciler.recover({
                trigger: "periodic",
                mode: "stale",
                dryRun: false,
                actorId: "system:process-dispatcher",
            }),
        ).resolves.toMatchObject({ failed: 1, enqueued: 1 });
        expect(recordRecoveryItem).toHaveBeenCalledWith(
            expect.objectContaining({
                item: expect.objectContaining({
                    runId: runId(6),
                    action: "failed",
                }),
            }),
        );
    });

    it("records a partial repair when enqueue succeeds before Outbox acknowledgement fails", async () => {
        const recordRecoveryItem = vi.fn(async () => undefined);
        const reconciler = createProcessRunReconciler({
            store: fakeStore({
                findRecoveryCandidates: async () => ({
                    candidates: [candidate(10, "queued", "stuck_queued", true)],
                }),
                acknowledgePendingOutbox: async () => {
                    throw new Error("PostgreSQL connection interrupted");
                },
                recordRecoveryItem,
            }),
            queue: fakeQueue({
                inspectJobs: async () => [
                    { runId: runId(10), state: "missing" },
                ],
            }),
            clock: () => AS_OF,
            createRecoveryId: () => RECOVERY_ID,
        });

        await expect(
            reconciler.recover({
                trigger: "periodic",
                mode: "stale",
                dryRun: false,
                actorId: "system:process-dispatcher",
            }),
        ).resolves.toMatchObject({ enqueued: 1, failed: 1 });
        expect(recordRecoveryItem).toHaveBeenCalledWith(
            expect.objectContaining({
                item: expect.objectContaining({
                    action: "enqueued",
                    outboxAction: "failed",
                }),
            }),
        );
    });

    it("marks the durable audit failed when queue inspection aborts the run", async () => {
        const failRecovery = vi.fn(async () => undefined);
        const reconciler = createProcessRunReconciler({
            store: fakeStore({
                findRecoveryCandidates: async () => ({
                    candidates: [candidate(8, "queued", "stuck_queued", false)],
                }),
                failRecovery,
            }),
            queue: fakeQueue({
                inspectJobs: async () => {
                    throw new Error("Redis unavailable");
                },
            }),
            clock: () => AS_OF,
            createRecoveryId: () => RECOVERY_ID,
        });

        await expect(
            reconciler.recover({
                trigger: "manual",
                mode: "all",
                dryRun: false,
                actorId: "operator:failure-test",
            }),
        ).rejects.toThrow("Redis unavailable");
        expect(failRecovery).toHaveBeenCalledWith({
            recoveryId: RECOVERY_ID,
            failedAt: AS_OF,
            errorCode: "RECOVERY_FAILED",
        });
    });

    it("uses the same audited stale path for periodic reconciliation", async () => {
        const findRecoveryCandidates = vi.fn(async () => ({
            candidates: [candidate(9, "queued", "stuck_queued", false)],
        }));
        const reconciler = createProcessRunReconciler({
            store: fakeStore({ findRecoveryCandidates }),
            queue: fakeQueue({
                inspectJobs: async () => [
                    { runId: runId(9), state: "runnable" },
                ],
            }),
            queuedAgeMs: 60_000,
            clock: () => AS_OF,
            createRecoveryId: () => RECOVERY_ID,
        });

        await expect(reconciler.reconcileOnce()).resolves.toEqual({
            found: 1,
            enqueued: 0,
            duplicates: 1,
            failed: 0,
        });
        expect(findRecoveryCandidates).toHaveBeenCalledWith({
            asOf: AS_OF,
            queuedBefore: "2026-08-09T09:59:00.000Z",
            mode: "stale",
            limit: 25,
        });
    });

    it("rejects unsafe bounds and actors before starting", async () => {
        expect(() =>
            createProcessRunReconciler({
                store: fakeStore(),
                queue: fakeQueue(),
                queuedAgeMs: 0,
            }),
        ).toThrow(
            "Queued Process Run recovery age must be a positive safe integer",
        );
        expect(() =>
            createProcessRunReconciler({
                store: fakeStore(),
                queue: fakeQueue(),
                batchSize: 101,
            }),
        ).toThrow("Process Run reconciliation batch size must not exceed 100");
        const reconciler = createProcessRunReconciler({
            store: fakeStore(),
            queue: fakeQueue(),
        });
        await expect(
            reconciler.recover({
                trigger: "manual",
                mode: "all",
                dryRun: true,
                actorId: " ",
            }),
        ).rejects.toThrow(
            "Process Recovery actor must be 1 to 512 UTF-8 bytes",
        );
    });
});

function fakeStore(
    overrides: Partial<ProcessRecoveryStore> = {},
): ProcessRecoveryStore {
    return {
        beginRecovery: async () => undefined,
        findRecoveryCandidates: async () => ({ candidates: [] }),
        acknowledgePendingOutbox: async () => 0,
        recordRecoveryItem: async () => undefined,
        completeRecovery: async () => undefined,
        failRecovery: async () => undefined,
        ...overrides,
    };
}

function fakeQueue(
    overrides: Partial<RecoverableProcessWorkQueue> = {},
): RecoverableProcessWorkQueue {
    return {
        enqueue: async () => "enqueued",
        inspectJobs: async (runIds) =>
            runIds.map((runIdValue) => ({
                runId: runIdValue,
                state: "missing",
            })),
        close: async () => undefined,
        ...overrides,
    };
}

function candidate(
    index: number,
    status: "queued" | "running",
    reason: ProcessRecoveryCandidate["reason"],
    pendingOutbox: boolean,
): ProcessRecoveryCandidate {
    return { runId: runId(index), status, reason, pendingOutbox };
}

function runId(index: number): string {
    return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

const AS_OF = "2026-08-09T10:00:00.000Z";
const RECOVERY_ID = "50000000-0000-4000-8000-000000000001";
