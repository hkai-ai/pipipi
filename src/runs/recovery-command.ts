import type {
    ProcessRecoveryReport,
    ProcessRunReconciler,
} from "./recovery.js";

export type QueueRecoveryCommandOptions = Readonly<{
    dryRun: boolean;
    mode: "stale" | "all";
    actorId: string;
    asOf?: string;
    cursor?: string;
    singleBatch: boolean;
}>;

export function parseQueueRecoveryCommandOptions(
    arguments_: readonly string[],
    environment: Readonly<Record<string, string | undefined>> = {},
): QueueRecoveryCommandOptions {
    let dryRun = true;
    let mode: "stale" | "all" = "all";
    let actorId = environment.PROCESS_RECOVERY_ACTOR_ID?.trim();
    let asOf: string | undefined;
    let cursor: string | undefined;
    let singleBatch = false;
    let executionModeWasExplicit = false;

    for (const argument of arguments_) {
        if (argument === "--apply" || argument === "--dry-run") {
            if (executionModeWasExplicit) {
                throw new Error("Specify only one of --apply or --dry-run");
            }
            executionModeWasExplicit = true;
            dryRun = argument === "--dry-run";
            continue;
        }
        if (argument === "--single-batch") {
            singleBatch = true;
            continue;
        }
        const [name, value] = splitArgument(argument);
        switch (name) {
            case "--mode":
                if (value !== "all" && value !== "stale") {
                    throw new Error("--mode must be all or stale");
                }
                mode = value;
                break;
            case "--actor":
                actorId = value.trim();
                break;
            case "--as-of":
                assertTimestamp(value, "--as-of");
                asOf = new Date(value).toISOString();
                break;
            case "--cursor":
                assertUuid(value, "--cursor");
                cursor = value;
                break;
            default:
                throw new Error(`Unknown Queue Recovery option: ${name}`);
        }
    }
    if (!actorId || Buffer.byteLength(actorId, "utf8") > 512) {
        throw new Error(
            "Queue Recovery requires --actor or PROCESS_RECOVERY_ACTOR_ID",
        );
    }
    return Object.freeze({
        dryRun,
        mode,
        actorId,
        ...(asOf ? { asOf } : {}),
        ...(cursor ? { cursor } : {}),
        singleBatch,
    });
}

export async function runQueueRecoveryCommand(options: {
    reconciler: ProcessRunReconciler;
    command: QueueRecoveryCommandOptions;
    clock?: () => string;
    maximumBatches?: number;
    onReport?: (report: ProcessRecoveryReport) => void;
    shouldStop?: () => boolean;
}): Promise<readonly ProcessRecoveryReport[]> {
    const maximumBatches = positiveInteger(
        options.maximumBatches ?? 10_000,
        "Queue Recovery maximum batches",
    );
    const asOf = options.command.asOf ?? (options.clock ?? isoNow)();
    assertTimestamp(asOf, "Queue Recovery cutoff");
    const reports: ProcessRecoveryReport[] = [];
    let cursor = options.command.cursor;

    do {
        const report = await options.reconciler.recover({
            trigger: "manual",
            mode: options.command.mode,
            dryRun: options.command.dryRun,
            actorId: options.command.actorId,
            asOf,
            ...(cursor ? { cursor } : {}),
        });
        reports.push(report);
        options.onReport?.(report);
        cursor = report.nextCursor;
        if (options.command.singleBatch || options.shouldStop?.() || !cursor) {
            break;
        }
        if (reports.length >= maximumBatches) {
            throw new Error("Queue Recovery exceeded its maximum batch count");
        }
    } while (cursor);

    return Object.freeze(reports);
}

function splitArgument(argument: string): [string, string] {
    const separator = argument.indexOf("=");
    if (separator < 1 || separator === argument.length - 1) {
        throw new Error(
            `Queue Recovery option requires --name=value: ${argument}`,
        );
    }
    return [argument.slice(0, separator), argument.slice(separator + 1)];
}

function assertTimestamp(value: string, label: string): void {
    if (!Number.isFinite(new Date(value).getTime())) {
        throw new Error(`${label} must be a valid timestamp`);
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

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function isoNow(): string {
    return new Date().toISOString();
}
