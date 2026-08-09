import { randomUUID } from "node:crypto";
import type {
    ProcessWorkJobInspection,
    RecoverableProcessWorkQueue,
} from "../queue/index.js";

export type ProcessRunRecoverySource = Readonly<{
    findRecoverable: (request: {
        asOf: string;
        queuedBefore: string;
        limit: number;
    }) => Promise<readonly Readonly<{ runId: string }>[]>;
}>;

export type ProcessRecoveryReason =
    | "recent_queued"
    | "stuck_queued"
    | "expired_lease"
    | "active_lease";

export type ProcessRecoveryCandidate = Readonly<{
    runId: string;
    status: "queued" | "running";
    reason: ProcessRecoveryReason;
    pendingOutbox: boolean;
}>;

export type ProcessRecoveryItem = Readonly<{
    runId: string;
    status: "queued" | "running";
    reason: ProcessRecoveryReason;
    pendingOutbox: boolean;
    queueState: ProcessWorkJobInspection["state"];
    action:
        | "none"
        | "would_enqueue"
        | "enqueued"
        | "duplicate"
        | "deferred"
        | "failed";
    outboxAction: "none" | "would_acknowledge" | "acknowledged" | "failed";
}>;

export type ProcessRecoveryCounters = Readonly<{
    found: number;
    missingJobs: number;
    existingJobs: number;
    terminalJobs: number;
    invalidJobs: number;
    activeLeases: number;
    pendingOutbox: number;
    enqueued: number;
    duplicates: number;
    outboxAcknowledged: number;
    failed: number;
}>;

export type ProcessRecoveryReport = ProcessRecoveryCounters &
    Readonly<{
        recoveryId: string;
        trigger: "periodic" | "manual";
        mode: "stale" | "all";
        dryRun: boolean;
        actorId: string;
        asOf: string;
        queuedBefore: string;
        items: readonly ProcessRecoveryItem[];
        nextCursor?: string;
    }>;

export type ProcessRecoveryStore = Readonly<{
    beginRecovery: (request: {
        recoveryId: string;
        trigger: "periodic" | "manual";
        mode: "stale" | "all";
        dryRun: boolean;
        actorId: string;
        asOf: string;
        queuedBefore: string;
        cursor?: string;
        startedAt: string;
    }) => Promise<void>;
    findRecoveryCandidates: (request: {
        asOf: string;
        queuedBefore: string;
        mode: "stale" | "all";
        cursor?: string;
        limit: number;
    }) => Promise<
        Readonly<{
            candidates: readonly ProcessRecoveryCandidate[];
            nextCursor?: string;
        }>
    >;
    acknowledgePendingOutbox: (request: {
        runId: string;
        acknowledgedAt: string;
    }) => Promise<number>;
    recordRecoveryItem: (request: {
        recoveryId: string;
        item: ProcessRecoveryItem;
        recordedAt: string;
    }) => Promise<void>;
    completeRecovery: (request: {
        recoveryId: string;
        counters: ProcessRecoveryCounters;
        nextCursor?: string;
        completedAt: string;
    }) => Promise<void>;
    failRecovery: (request: {
        recoveryId: string;
        failedAt: string;
        errorCode: "RECOVERY_FAILED";
    }) => Promise<void>;
}>;

export type ProcessRunReconciliationResult = Readonly<{
    found: number;
    enqueued: number;
    duplicates: number;
    failed: number;
}>;

export type ProcessRunReconciler = Readonly<{
    reconcileOnce: () => Promise<ProcessRunReconciliationResult>;
    recover: (request: {
        trigger: "periodic" | "manual";
        mode: "stale" | "all";
        dryRun: boolean;
        actorId: string;
        asOf?: string;
        cursor?: string;
    }) => Promise<ProcessRecoveryReport>;
}>;

export function createProcessRunReconciler(options: {
    store: ProcessRecoveryStore;
    queue: RecoverableProcessWorkQueue;
    queuedAgeMs?: number;
    batchSize?: number;
    clock?: () => string;
    createRecoveryId?: () => string;
}): ProcessRunReconciler {
    const queuedAgeMs = positiveInteger(
        options.queuedAgeMs ?? 60_000,
        "Queued Process Run recovery age",
    );
    const batchSize = boundedBatchSize(options.batchSize ?? 25);
    const clock = options.clock ?? (() => new Date().toISOString());
    const createRecoveryId = options.createRecoveryId ?? randomUUID;

    const recover: ProcessRunReconciler["recover"] = async (request) => {
        if (request.trigger !== "periodic" && request.trigger !== "manual") {
            throw new Error("Process Recovery trigger is invalid");
        }
        if (request.mode !== "stale" && request.mode !== "all") {
            throw new Error("Process Recovery mode is invalid");
        }
        if (typeof request.dryRun !== "boolean") {
            throw new Error("Process Recovery dry-run flag is invalid");
        }
        assertActor(request.actorId);
        if (request.cursor)
            assertUuid(request.cursor, "Process Recovery cursor");
        const asOf = request.asOf ?? clock();
        const queuedBefore = subtractMilliseconds(asOf, queuedAgeMs);
        const recoveryId = createRecoveryId();
        assertUuid(recoveryId, "Process Recovery ID");
        const startedAt = clock();
        assertTimestamp(startedAt);
        let auditStarted = false;

        try {
            const selection = await options.store.findRecoveryCandidates({
                asOf,
                queuedBefore,
                mode: request.mode,
                ...(request.cursor ? { cursor: request.cursor } : {}),
                limit: batchSize,
            });
            if (
                selection.candidates.length === 0 &&
                request.trigger === "periodic" &&
                !request.dryRun
            ) {
                return Object.freeze({
                    recoveryId,
                    trigger: request.trigger,
                    mode: request.mode,
                    dryRun: request.dryRun,
                    actorId: request.actorId,
                    asOf,
                    queuedBefore,
                    ...Object.freeze(mutableCounters()),
                    items: Object.freeze([]),
                });
            }
            await options.store.beginRecovery({
                recoveryId,
                trigger: request.trigger,
                mode: request.mode,
                dryRun: request.dryRun,
                actorId: request.actorId,
                asOf,
                queuedBefore,
                ...(request.cursor ? { cursor: request.cursor } : {}),
                startedAt,
            });
            auditStarted = true;
            const inspections =
                selection.candidates.length === 0
                    ? []
                    : await options.queue.inspectJobs(
                          selection.candidates.map(
                              (candidate) => candidate.runId,
                          ),
                      );
            const inspectionByRunId = validatedInspections(
                selection.candidates,
                inspections,
            );
            const counters = mutableCounters();
            const items: ProcessRecoveryItem[] = [];

            for (const candidate of selection.candidates) {
                counters.found += 1;
                if (candidate.reason === "active_lease")
                    counters.activeLeases += 1;
                if (candidate.pendingOutbox) counters.pendingOutbox += 1;
                const queueState = inspectionByRunId.get(candidate.runId);
                if (!queueState)
                    throw new Error("Queue inspection omitted a Process Run");
                if (queueState === "missing") counters.missingJobs += 1;
                else if (queueState === "terminal") counters.terminalJobs += 1;
                else if (queueState === "invalid") counters.invalidJobs += 1;
                else counters.existingJobs += 1;

                let item: ProcessRecoveryItem;
                try {
                    item = request.dryRun
                        ? dryRunItem(candidate, queueState)
                        : await repairItem(
                              options,
                              candidate,
                              queueState,
                              clock,
                              counters,
                          );
                } catch {
                    counters.failed += 1;
                    item = Object.freeze({
                        runId: candidate.runId,
                        status: candidate.status,
                        reason: candidate.reason,
                        pendingOutbox: candidate.pendingOutbox,
                        queueState,
                        action: "failed",
                        outboxAction: candidate.pendingOutbox
                            ? "failed"
                            : "none",
                    });
                }
                items.push(item);
                await options.store.recordRecoveryItem({
                    recoveryId,
                    item,
                    recordedAt: clock(),
                });
            }

            const frozenCounters = Object.freeze({ ...counters });
            const completedAt = clock();
            await options.store.completeRecovery({
                recoveryId,
                counters: frozenCounters,
                ...(selection.nextCursor
                    ? { nextCursor: selection.nextCursor }
                    : {}),
                completedAt,
            });
            return Object.freeze({
                recoveryId,
                trigger: request.trigger,
                mode: request.mode,
                dryRun: request.dryRun,
                actorId: request.actorId,
                asOf,
                queuedBefore,
                ...frozenCounters,
                items: Object.freeze(items),
                ...(selection.nextCursor
                    ? { nextCursor: selection.nextCursor }
                    : {}),
            });
        } catch (error) {
            if (auditStarted) {
                try {
                    await options.store.failRecovery({
                        recoveryId,
                        failedAt: clock(),
                        errorCode: "RECOVERY_FAILED",
                    });
                } catch {
                    // Preserve the recovery failure. The running audit row still shows an
                    // interrupted operation when recording the terminal audit also fails.
                }
            }
            throw error;
        }
    };

    return Object.freeze({
        recover,
        reconcileOnce: async () => {
            const report = await recover({
                trigger: "periodic",
                mode: "stale",
                dryRun: false,
                actorId: "system:process-dispatcher",
            });
            return Object.freeze({
                found: report.found,
                enqueued: report.enqueued,
                duplicates: report.existingJobs + report.duplicates,
                failed: report.failed,
            });
        },
    });
}

async function repairItem(
    options: {
        store: ProcessRecoveryStore;
        queue: RecoverableProcessWorkQueue;
    },
    candidate: ProcessRecoveryCandidate,
    queueState: ProcessWorkJobInspection["state"],
    clock: () => string,
    counters: MutableCounters,
): Promise<ProcessRecoveryItem> {
    let action: ProcessRecoveryItem["action"] = "none";
    let validQueueJob = queueState === "runnable";
    if (candidate.reason === "active_lease" && !validQueueJob) {
        action = "deferred";
    } else if (!validQueueJob) {
        const result = await options.queue.enqueue({
            schemaVersion: 1,
            runId: candidate.runId,
        });
        action = result;
        validQueueJob = true;
        if (result === "enqueued") counters.enqueued += 1;
        else counters.duplicates += 1;
    }

    let outboxAction: ProcessRecoveryItem["outboxAction"] = "none";
    if (candidate.pendingOutbox && validQueueJob) {
        try {
            const acknowledged = await options.store.acknowledgePendingOutbox({
                runId: candidate.runId,
                acknowledgedAt: clock(),
            });
            if (acknowledged > 0) {
                counters.outboxAcknowledged += acknowledged;
                outboxAction = "acknowledged";
            }
        } catch {
            counters.failed += 1;
            outboxAction = "failed";
        }
    }
    return Object.freeze({
        runId: candidate.runId,
        status: candidate.status,
        reason: candidate.reason,
        pendingOutbox: candidate.pendingOutbox,
        queueState,
        action,
        outboxAction,
    });
}

function dryRunItem(
    candidate: ProcessRecoveryCandidate,
    queueState: ProcessWorkJobInspection["state"],
): ProcessRecoveryItem {
    const validQueueJob = queueState === "runnable";
    const action =
        candidate.reason === "active_lease" && !validQueueJob
            ? "deferred"
            : validQueueJob
              ? "none"
              : "would_enqueue";
    return Object.freeze({
        runId: candidate.runId,
        status: candidate.status,
        reason: candidate.reason,
        pendingOutbox: candidate.pendingOutbox,
        queueState,
        action,
        outboxAction:
            candidate.pendingOutbox &&
            (validQueueJob || action === "would_enqueue")
                ? "would_acknowledge"
                : "none",
    });
}

function validatedInspections(
    candidates: readonly ProcessRecoveryCandidate[],
    inspections: readonly ProcessWorkJobInspection[],
): ReadonlyMap<string, ProcessWorkJobInspection["state"]> {
    const expected = new Set(candidates.map((candidate) => candidate.runId));
    const result = new Map<string, ProcessWorkJobInspection["state"]>();
    for (const inspection of inspections) {
        if (!expected.has(inspection.runId) || result.has(inspection.runId)) {
            throw new Error(
                "Queue inspection returned unexpected Process Runs",
            );
        }
        result.set(inspection.runId, inspection.state);
    }
    if (result.size !== expected.size) {
        throw new Error("Queue inspection omitted a Process Run");
    }
    return result;
}

type MutableCounters = {
    found: number;
    missingJobs: number;
    existingJobs: number;
    terminalJobs: number;
    invalidJobs: number;
    activeLeases: number;
    pendingOutbox: number;
    enqueued: number;
    duplicates: number;
    outboxAcknowledged: number;
    failed: number;
};

function mutableCounters(): MutableCounters {
    return {
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
    };
}

function boundedBatchSize(value: number): number {
    const batchSize = positiveInteger(
        value,
        "Process Run reconciliation batch size",
    );
    if (batchSize > 100) {
        throw new Error(
            "Process Run reconciliation batch size must not exceed 100",
        );
    }
    return batchSize;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function assertActor(value: string): void {
    if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        Buffer.byteLength(value, "utf8") > 512
    ) {
        throw new Error("Process Recovery actor must be 1 to 512 UTF-8 bytes");
    }
}

function assertUuid(value: string, label: string): void {
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value,
        )
    ) {
        throw new Error(`${label} must be a UUID`);
    }
}

function assertTimestamp(value: string): void {
    if (!Number.isFinite(new Date(value).getTime())) {
        throw new Error("Process Run reconciliation timestamp is invalid");
    }
}

function subtractMilliseconds(timestamp: string, durationMs: number): string {
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time)) {
        throw new Error("Process Run reconciliation timestamp is invalid");
    }
    return new Date(time - durationMs).toISOString();
}
