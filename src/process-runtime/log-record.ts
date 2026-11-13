/** 按白名单定义并净化可归档与展示的 Process Run 记录。 */

import {
    type ActivityDiagnostic,
    sanitizeActivityDiagnostic,
} from "./diagnostics.js";
import { type PiSessionTrace, sanitizePiSessions } from "./pi-trace.js";
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

export type ProcessRunLogEvent =
    | Readonly<{
          event: "process_run_attempt_started";
      }>
    | Readonly<{
          event: "process_run_activity_started";
          activity: string;
          activityId?: number;
      }>
    | Readonly<{
          event: "process_run_activity_finished";
          activity: string;
          activityId?: number;
          outcome: "succeeded" | "failed" | "cancelled";
          durationMs: number;
          sessions?: PiSessionTrace[];
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
    const instance =
        Number.isSafeInteger(record.activityId) && Number(record.activityId) > 0
            ? { activityId: Number(record.activityId) }
            : {};
    if (record.event === "process_run_attempt_started")
        return { ...base, event: record.event };
    if (
        record.event === "process_run_activity_started" &&
        typeof record.activity === "string"
    )
        return {
            ...base,
            event: record.event,
            activity: record.activity,
            ...instance,
        };
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
    ) {
        const sessions = sanitizePiSessions(record.sessions);
        return {
            ...base,
            event: record.event,
            activity: record.activity,
            ...instance,
            ...(sessions ? { sessions } : {}),
            outcome: record.outcome,
            durationMs: record.durationMs,
            ...detail,
        };
    }
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
