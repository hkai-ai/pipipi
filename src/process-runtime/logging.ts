/** 管理 Attempt 的活动实例、计时与多个观测 Sink 的故障隔离。 */
import {
    type ActivityDiagnostic,
    sanitizeActivityDiagnostic,
} from "./diagnostics.js";
import type { ProcessRunLogEvent, ProcessRunLogRecord } from "./log-record.js";
import { sanitizePiSessions } from "./pi-trace.js";
import type { ProcessErrorCode } from "./result.js";
import { type TraceActivity, withTraceActivity } from "./trace-context.js";

export {
    type ProcessRunLogRecord,
    sanitizeProcessRunLogRecord,
} from "./log-record.js";

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
        Readonly<{ scope: TraceActivity; startedAt: number | undefined }>
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
        let sessions;
        try {
            if (activeActivity.scope.sessions.length)
                sessions = sanitizePiSessions(activeActivity.scope.sessions);
        } catch {
            // 单个采集器异常仍须关闭活动并保留业务结果。
        }
        emit({
            event: "process_run_activity_finished",
            activity: activeActivity.scope.activity,
            activityId,
            ...(sessions ? { sessions } : {}),
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
            const scope: TraceActivity = {
                runId: options.runId,
                attemptNumber: options.attemptNumber,
                activityId,
                activity,
                sessions: [],
            };
            activeActivities.set(activityId, { scope, startedAt });
            emit({
                event: "process_run_activity_started",
                activity,
                activityId,
            });
            try {
                const result = await withTraceActivity(scope, operation);
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
