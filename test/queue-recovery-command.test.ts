import { describe, expect, it, vi } from "vitest";
import type {
    ProcessRecoveryReport,
    ProcessRunReconciler,
} from "../src/runs/recovery.js";
import {
    parseQueueRecoveryCommandOptions,
    runQueueRecoveryCommand,
} from "../src/runs/recovery-command.js";

describe("Queue Recovery command", () => {
    it("defaults to a safe dry-run and requires an audited actor", () => {
        expect(
            parseQueueRecoveryCommandOptions([], {
                PROCESS_RECOVERY_ACTOR_ID: "operator:environment",
            }),
        ).toEqual({
            dryRun: true,
            mode: "all",
            actorId: "operator:environment",
            singleBatch: false,
        });
        expect(() => parseQueueRecoveryCommandOptions([])).toThrow(
            "Queue Recovery requires --actor or PROCESS_RECOVERY_ACTOR_ID",
        );
    });

    it("parses explicit apply, scope, cutoff, cursor, and batch control", () => {
        expect(
            parseQueueRecoveryCommandOptions([
                "--apply",
                "--mode=stale",
                "--actor=operator:alice",
                "--as-of=2026-08-09T10:00:00Z",
                `--cursor=${RUN_IDS[0]}`,
                "--single-batch",
            ]),
        ).toEqual({
            dryRun: false,
            mode: "stale",
            actorId: "operator:alice",
            asOf: AS_OF,
            cursor: RUN_IDS[0],
            singleBatch: true,
        });
        expect(() =>
            parseQueueRecoveryCommandOptions([
                "--apply",
                "--dry-run",
                "--actor=operator:alice",
            ]),
        ).toThrow("Specify only one of --apply or --dry-run");
    });

    it("continues every batch with one cutoff and reports each durable cursor", async () => {
        const recover = vi
            .fn<ProcessRunReconciler["recover"]>()
            .mockResolvedValueOnce(report({ nextCursor: RUN_IDS[0] }))
            .mockResolvedValueOnce(report({ recoveryId: RECOVERY_IDS[1] }));
        const onReport = vi.fn();

        await expect(
            runQueueRecoveryCommand({
                reconciler: fakeReconciler(recover),
                command: {
                    dryRun: false,
                    mode: "all",
                    actorId: "operator:alice",
                    singleBatch: false,
                },
                clock: () => AS_OF,
                onReport,
            }),
        ).resolves.toHaveLength(2);
        expect(recover.mock.calls).toEqual([
            [
                {
                    trigger: "manual",
                    mode: "all",
                    dryRun: false,
                    actorId: "operator:alice",
                    asOf: AS_OF,
                },
            ],
            [
                {
                    trigger: "manual",
                    mode: "all",
                    dryRun: false,
                    actorId: "operator:alice",
                    asOf: AS_OF,
                    cursor: RUN_IDS[0],
                },
            ],
        ]);
        expect(onReport).toHaveBeenCalledTimes(2);
    });
});

function fakeReconciler(
    recover: ProcessRunReconciler["recover"],
): ProcessRunReconciler {
    return {
        recover,
        reconcileOnce: async () => ({
            found: 0,
            enqueued: 0,
            duplicates: 0,
            failed: 0,
        }),
    };
}

function report(
    overrides: Partial<ProcessRecoveryReport> = {},
): ProcessRecoveryReport {
    return {
        recoveryId: RECOVERY_IDS[0],
        trigger: "manual",
        mode: "all",
        dryRun: false,
        actorId: "operator:alice",
        asOf: AS_OF,
        queuedBefore: "2026-08-09T09:59:00.000Z",
        found: 0,
        missingJobs: 0,
        existingJobs: 0,
        terminalJobs: 0,
        invalidJobs: 0,
        activeLeases: 0,
        pendingOutbox: 0,
        enqueued: 0,
        duplicates: 0,
        outboxAcknowledged: 0,
        failed: 0,
        items: [],
        ...overrides,
    };
}

const AS_OF = "2026-08-09T10:00:00.000Z";
const RUN_IDS = ["00000000-0000-4000-8000-000000000001"] as const;
const RECOVERY_IDS = [
    "50000000-0000-4000-8000-000000000001",
    "50000000-0000-4000-8000-000000000002",
] as const;
