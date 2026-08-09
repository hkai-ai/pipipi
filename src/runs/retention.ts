import type { BackgroundRuntime } from "../api/role.js";
import type {
    PostgresRetentionCleanup,
    RetentionCleanupBatchResult,
} from "./postgres-retention.js";

export type RetentionCleanupSweepResult = Readonly<{
    asOf: string;
    batches: number;
    examined: number;
    inputContentsDeleted: number;
    resultsDeleted: number;
    deliveryAttemptsDeleted: number;
    runsDeleted: number;
    deferredRuns: number;
    completed: boolean;
    nextCursor?: string;
}>;

export type RetentionCleaner = Readonly<{
    runSweep: (request?: {
        asOf?: string;
        cursor?: string;
        signal?: AbortSignal;
    }) => Promise<RetentionCleanupSweepResult>;
}>;

export function createRetentionCleaner(options: {
    cleanup: PostgresRetentionCleanup;
    batchSize?: number;
    maximumBatchesPerSweep?: number;
    clock?: () => string;
    onBatch?: (result: RetentionCleanupBatchResult) => void;
}): RetentionCleaner {
    const batchSize = boundedPositiveInteger(
        options.batchSize ?? 25,
        100,
        "Retention cleanup batch size",
    );
    const maximumBatchesPerSweep = boundedPositiveInteger(
        options.maximumBatchesPerSweep ?? 100,
        10_000,
        "Retention cleanup maximum batches per sweep",
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
                addBatch(totals, result);
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

export function createRetentionCleanerRuntime(options: {
    cleaner: RetentionCleaner;
    databaseReady: () => Promise<void>;
    closeResources: () => Promise<void>;
    intervalMs?: number;
    onResult?: (result: RetentionCleanupSweepResult) => void;
    onError?: () => void;
}): BackgroundRuntime {
    const intervalMs = positiveInteger(
        options.intervalMs ?? 3_600_000,
        "Retention cleanup interval",
    );
    const onResult = options.onResult ?? reportCleanupResult;
    const onError = options.onError ?? reportCleanupError;
    let current: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let controller: AbortController | undefined;
    let continuation: Readonly<{ asOf: string; cursor: string }> | undefined;
    let started = false;
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
                onResult(result);
            })
            .catch(() => onError())
            .finally(() => {
                current = undefined;
                controller = undefined;
                if (!closed) timer = setTimeout(run, intervalMs);
            });
    };

    return Object.freeze({
        start: async () => {
            if (closed) throw new Error("Retention Cleaner Runtime is closed");
            if (started) return;
            started = true;
            run();
        },
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
    inputContentsDeleted: number;
    resultsDeleted: number;
    deliveryAttemptsDeleted: number;
    runsDeleted: number;
    deferredRuns: number;
};

function mutableTotals(): MutableTotals {
    return {
        examined: 0,
        inputContentsDeleted: 0,
        resultsDeleted: 0,
        deliveryAttemptsDeleted: 0,
        runsDeleted: 0,
        deferredRuns: 0,
    };
}

function addBatch(
    totals: MutableTotals,
    result: RetentionCleanupBatchResult,
): void {
    totals.examined += result.examined;
    totals.inputContentsDeleted += result.inputContentsDeleted;
    totals.resultsDeleted += result.resultsDeleted;
    totals.deliveryAttemptsDeleted += result.deliveryAttemptsDeleted;
    totals.runsDeleted += result.runsDeleted;
    totals.deferredRuns += result.deferredRuns;
}

function boundedPositiveInteger(
    value: number,
    maximum: number,
    label: string,
): number {
    const parsed = positiveInteger(value, label);
    if (parsed > maximum)
        throw new Error(`${label} must not exceed ${maximum}`);
    return parsed;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function assertTimestamp(value: string): void {
    if (!Number.isFinite(new Date(value).getTime())) {
        throw new Error("Retention cleanup timestamp is invalid");
    }
}

function reportCleanupResult(result: RetentionCleanupSweepResult): void {
    console.log(
        JSON.stringify({
            event: "retention_cleanup_sweep_completed",
            ...result,
            timestamp: new Date().toISOString(),
        }),
    );
}

function reportCleanupError(): void {
    console.error(
        JSON.stringify({
            event: "retention_cleanup_sweep_failed",
            timestamp: new Date().toISOString(),
        }),
    );
}
