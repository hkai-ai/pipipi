import pino, {
    type DestinationStream,
    type LevelWithSilent,
    type Logger,
} from "pino";
import type {
    ProcessRunLogRecord,
    ProcessRunLogSink,
} from "../process-runtime/index.js";

const defaultLevel: LevelWithSilent = "info";
const levels = new Set<LevelWithSilent>([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
]);
const redactedPaths = [
    "acceptedInput",
    "input",
    "output",
    "prompt",
    "messages",
    "toolArguments",
    "authorization",
    "cookie",
    "password",
    "secret",
    "token",
    "apiKey",
    "headers.authorization",
    "headers.cookie",
] as const;

export function createPinoProcessRunLogSink(
    options: { level?: string; destination?: DestinationStream } = {},
): ProcessRunLogSink {
    const logger = pino(
        {
            level: parseLevel(options.level),
            timestamp: false,
            redact: {
                paths: [...redactedPaths],
                remove: true,
            },
        },
        options.destination,
    ).child({
        service: "pi-business-processing-service",
        module: "process-run-activity-logging",
    });

    return (record) => writeRecord(logger, record);
}

function parseLevel(value: string | undefined): LevelWithSilent {
    if (value === undefined) return defaultLevel;
    if (levels.has(value as LevelWithSilent)) return value as LevelWithSilent;
    throw new Error(
        "PROCESS_RUN_LOG_LEVEL must be fatal, error, warn, info, debug, trace, or silent",
    );
}

function writeRecord(logger: Logger, record: ProcessRunLogRecord): void {
    const level = recordLevel(record);
    logger[level](record, record.event);
}

function recordLevel(record: ProcessRunLogRecord): "info" | "warn" | "error" {
    if (
        record.event === "process_run_attempt_finished" &&
        record.outcome === "failed" &&
        record.errorCode === "INTERNAL_ERROR"
    ) {
        return "error";
    }
    if (
        (record.event === "process_run_activity_finished" &&
            record.outcome !== "succeeded") ||
        (record.event === "process_run_attempt_finished" &&
            record.outcome !== "succeeded")
    ) {
        return "warn";
    }
    return "info";
}
