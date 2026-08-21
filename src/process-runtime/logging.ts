/** 定义 Process Run 日志事件结构，创建单次 Attempt 的活动日志并支持多 Sink 合并 */
import type { ProcessErrorCode } from "./result.js";

type ProcessRunLogBase = Readonly<{
    schemaVersion: 1;
    timestamp: string;
    runId: string;
    process: string;
    version: string;
    attemptNumber: number;
    sequence: number;
}>;

type ProcessRunLogEvent =
    | Readonly<{
          event: "process_run_attempt_started";
      }>
    | Readonly<{
          event: "process_run_activity_started";
          activity: string;
      }>
    | Readonly<{
          event: "process_run_activity_finished";
          activity: string;
          outcome: "succeeded" | "failed" | "cancelled";
          durationMs: number;
      }>
    | Readonly<{
          event: "process_run_attempt_finished";
          outcome: "succeeded";
          durationMs: number;
      }>
    | Readonly<{
          event: "process_run_attempt_finished";
          outcome: "failed" | "timed_out" | "cancelled";
          durationMs: number;
          errorCode: ProcessErrorCode;
      }>;

export type ProcessRunLogRecord = ProcessRunLogBase & ProcessRunLogEvent;

export type ProcessRunLogSink = (record: ProcessRunLogRecord) => void;

export type ProcessRunLogClock = Readonly<{
    timestamp: () => string;
    monotonicMilliseconds: () => number;
}>;

export type ProcessRunActivity = <Result>(
    activity: string,
    operation: () => Result | Promise<Result>,
) => Promise<Result>;

type AttemptOutcome =
    | Readonly<{ outcome: "succeeded" }>
    | Readonly<{
          outcome: "failed" | "timed_out" | "cancelled";
          errorCode: ProcessErrorCode;
      }>;

export type ProcessRunAttemptLog = Readonly<{
    runActivity: ProcessRunActivity;
    finish: (outcome: AttemptOutcome) => void;
}>;

const systemClock: ProcessRunLogClock = Object.freeze({
    timestamp: () => new Date().toISOString(),
    monotonicMilliseconds: () => performance.now(),
});

export function createProcessRunAttemptLog(options: {
    runId: string;
    process: string;
    version: string;
    attemptNumber: number;
    signal: AbortSignal;
    sink?: ProcessRunLogSink;
    clock?: ProcessRunLogClock;
}): ProcessRunAttemptLog {
    if (!options.sink) {
        return Object.freeze({
            runActivity: async (_activity, operation) => operation(),
            finish: () => {},
        });
    }

    const clock = options.clock ?? systemClock;
    const attemptStartedAt = monotonicMilliseconds(clock);
    let sequence = 0;
    let finished = false;
    let nextActivityId = 0;
    const activeActivities = new Map<
        number,
        Readonly<{ activity: string; startedAt: number | undefined }>
    >();
    const base = {
        schemaVersion: 1 as const,
        runId: options.runId,
        process: options.process,
        version: options.version,
        attemptNumber: options.attemptNumber,
    };
    const emit = (record: ProcessRunLogEvent): void => {
        const timestamp = tryTimestamp(clock);
        sequence += 1;
        if (!timestamp) return;
        try {
            options.sink?.({
                ...base,
                ...record,
                timestamp,
                sequence,
            } as ProcessRunLogRecord);
        } catch {
            // Run logging is best-effort and cannot change process execution.
        }
    };
    const finishActivity = (
        activityId: number,
        outcome: "succeeded" | "failed" | "cancelled",
    ): void => {
        const activeActivity = activeActivities.get(activityId);
        if (!activeActivity) return;
        activeActivities.delete(activityId);
        emit({
            event: "process_run_activity_finished",
            activity: activeActivity.activity,
            outcome,
            durationMs: elapsedMilliseconds(clock, activeActivity.startedAt),
        });
    };

    emit({ event: "process_run_attempt_started" });

    return Object.freeze({
        runActivity: async (activity, operation) => {
            if (finished) return operation();
            const activityId = ++nextActivityId;
            const startedAt = monotonicMilliseconds(clock);
            activeActivities.set(activityId, { activity, startedAt });
            emit({ event: "process_run_activity_started", activity });
            try {
                const result = await operation();
                finishActivity(
                    activityId,
                    options.signal.aborted ? "cancelled" : "succeeded",
                );
                return result;
            } catch (error) {
                finishActivity(
                    activityId,
                    options.signal.aborted ? "cancelled" : "failed",
                );
                throw error;
            }
        },
        finish: (outcome) => {
            if (finished) return;
            finished = true;
            for (const activityId of [...activeActivities.keys()].reverse()) {
                finishActivity(activityId, "cancelled");
            }
            const durationMs = elapsedMilliseconds(clock, attemptStartedAt);
            if (outcome.outcome === "succeeded") {
                emit({
                    event: "process_run_attempt_finished",
                    outcome: "succeeded",
                    durationMs,
                });
                return;
            }
            emit({
                event: "process_run_attempt_finished",
                outcome: outcome.outcome,
                durationMs,
                errorCode: outcome.errorCode,
            });
        },
    });
}

/**
 * Fans one activity record out to several Sinks. A Sink that throws is isolated
 * so a failing destination cannot silence the others, and logging stays unable
 * to change a Process Run's result.
 */
export function combineProcessRunLogSinks(
    ...sinks: readonly ProcessRunLogSink[]
): ProcessRunLogSink {
    return (record) => {
        for (const sink of sinks) {
            try {
                sink(record);
            } catch {
                // A destination failure must not affect the others.
            }
        }
    };
}

function tryTimestamp(clock: ProcessRunLogClock): string | undefined {
    try {
        return clock.timestamp();
    } catch {
        return undefined;
    }
}

function monotonicMilliseconds(clock: ProcessRunLogClock): number | undefined {
    try {
        const value = clock.monotonicMilliseconds();
        return Number.isFinite(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function elapsedMilliseconds(
    clock: ProcessRunLogClock,
    startedAt: number | undefined,
): number {
    const finishedAt = monotonicMilliseconds(clock);
    if (startedAt === undefined || finishedAt === undefined) return 0;
    return Math.max(0, Math.round(finishedAt - startedAt));
}
