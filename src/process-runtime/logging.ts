/** 定义并净化 Process Run 活动记录，管理 Attempt 日志与多 Sink 故障隔离。 */

import {
    type ActivityDiagnostic,
    sanitizeActivityDiagnostic,
} from "./diagnostics.js";
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
          diagnostic?: ActivityDiagnostic;
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
          diagnostic?: ActivityDiagnostic;
      }>;

export type ProcessRunLogRecord = ProcessRunLogBase & ProcessRunLogEvent;

/** 从归档或展示输入投影允许的活动字段，丢弃旧数据中的额外属性。 */
export function sanitizeProcessRunLogRecord(
    value: unknown,
): ProcessRunLogRecord | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (
        record.schemaVersion !== 1 ||
        ![record.timestamp, record.runId, record.process, record.version].every(
            (part) => typeof part === "string",
        ) ||
        !Number.isSafeInteger(record.attemptNumber) ||
        !Number.isSafeInteger(record.sequence)
    )
        return undefined;
    const base: ProcessRunLogBase = {
        schemaVersion: 1,
        timestamp: record.timestamp as string,
        runId: record.runId as string,
        process: record.process as string,
        version: record.version as string,
        attemptNumber: record.attemptNumber as number,
        sequence: record.sequence as number,
    };
    if (record.event === "process_run_attempt_started")
        return { ...base, event: record.event };
    if (
        record.event === "process_run_activity_started" &&
        typeof record.activity === "string"
    )
        return { ...base, event: record.event, activity: record.activity };
    if (
        typeof record.durationMs !== "number" ||
        !Number.isFinite(record.durationMs) ||
        record.durationMs < 0
    )
        return undefined;
    const diagnostic = sanitizeActivityDiagnostic(record.diagnostic);
    const detail = diagnostic ? { diagnostic } : {};
    if (
        record.event === "process_run_activity_finished" &&
        typeof record.activity === "string" &&
        (record.outcome === "succeeded" ||
            record.outcome === "failed" ||
            record.outcome === "cancelled")
    )
        return {
            ...base,
            event: record.event,
            activity: record.activity,
            outcome: record.outcome,
            durationMs: record.durationMs,
            ...detail,
        };
    if (record.event !== "process_run_attempt_finished") return undefined;
    if (record.outcome === "succeeded")
        return {
            ...base,
            event: record.event,
            outcome: record.outcome,
            durationMs: record.durationMs,
        };
    const codes = {
        AGENT_FAILURE: true,
        DEPENDENCY_FAILURE: true,
        DEPENDENCY_FAILURE_AFTER_COMMIT: true,
        INTERNAL_ERROR: true,
        INVALID_INPUT: true,
        INVALID_OUTPUT: true,
        PROCESS_NOT_FOUND: true,
        PROCESS_TIMEOUT: true,
    } satisfies Record<ProcessErrorCode, true>;
    if (
        typeof record.errorCode !== "string" ||
        !Object.hasOwn(codes, record.errorCode) ||
        !(
            record.outcome === "failed" ||
            record.outcome === "timed_out" ||
            record.outcome === "cancelled"
        )
    )
        return undefined;
    return {
        ...base,
        event: record.event,
        outcome: record.outcome,
        durationMs: record.durationMs,
        errorCode: record.errorCode as ProcessErrorCode,
        ...detail,
    };
}

export type ProcessRunLogSink = (record: ProcessRunLogRecord) => void;

export type ProcessRunLogClock = Readonly<{
    timestamp: () => string;
    monotonicMilliseconds: () => number;
}>;

export type ProcessRunActivity = <Result>(
    activity: string,
    operation: () => Result | Promise<Result>,
    diagnose?: (error: unknown) => ActivityDiagnostic,
) => Promise<Result>;

type AttemptOutcome =
    | Readonly<{ outcome: "succeeded" }>
    | Readonly<{
          outcome: "failed" | "timed_out" | "cancelled";
          errorCode: ProcessErrorCode;
          diagnostic?: ActivityDiagnostic;
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
            const writing = options.sink?.({
                ...base,
                ...record,
                timestamp,
                sequence,
            } as ProcessRunLogRecord);
            void Promise.resolve(writing).catch(() => {});
        } catch {
            // Run logging is best-effort and cannot change process execution.
        }
    };
    const finishActivity = (
        activityId: number,
        outcome: "succeeded" | "failed" | "cancelled",
        diagnostic?: ActivityDiagnostic,
    ): void => {
        const activeActivity = activeActivities.get(activityId);
        if (!activeActivity) return;
        activeActivities.delete(activityId);
        emit({
            event: "process_run_activity_finished",
            activity: activeActivity.activity,
            outcome,
            durationMs: elapsedMilliseconds(clock, activeActivity.startedAt),
            ...(diagnostic ? { diagnostic } : {}),
        });
    };

    emit({ event: "process_run_attempt_started" });

    return Object.freeze({
        runActivity: async (activity, operation, diagnose) => {
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
                let diagnostic: ActivityDiagnostic | undefined;
                try {
                    if (!options.signal.aborted)
                        diagnostic = diagnose
                            ? sanitizeActivityDiagnostic(diagnose(error))
                            : { stage: "execution", code: "internal_failure" };
                } catch {
                    // 诊断失败不得覆盖原始业务结果。
                }
                finishActivity(
                    activityId,
                    options.signal.aborted ? "cancelled" : "failed",
                    diagnostic,
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
                ...(outcome.diagnostic
                    ? {
                          diagnostic: sanitizeActivityDiagnostic(
                              outcome.diagnostic,
                          ),
                      }
                    : {}),
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
                void Promise.resolve(sink(record)).catch(() => {});
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
