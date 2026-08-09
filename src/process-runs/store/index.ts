import type {
    AcceptedProcessInput,
    ProcessErrorCode,
} from "../../processes/runtime/index.js";

export type ProcessRunStatus = "queued" | "running" | "succeeded" | "failed";

export type ProcessRunFailure = Readonly<{
    code: ProcessErrorCode;
    message: string;
}>;

type StoredProcessRunBase = Readonly<{
    schemaVersion: 1;
    runId: string;
    ownerId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    process: string;
    version: string;
    createdAt: string;
    updatedAt: string;
    attemptCount: number;
    revision: number;
}>;

export type StoredProcessRun =
    | (StoredProcessRunBase &
          Readonly<{
              status: "queued";
              acceptedInput: AcceptedProcessInput;
              startedAt?: string;
          }>)
    | (StoredProcessRunBase &
          Readonly<{
              status: "running";
              acceptedInput: AcceptedProcessInput;
              claimToken: string;
              claimExpiresAt: string;
              startedAt: string;
          }>)
    | (StoredProcessRunBase &
          Readonly<{
              status: "succeeded";
              acceptedInput?: AcceptedProcessInput;
              startedAt: string;
              finishedAt: string;
          }> &
          (
              | Readonly<{ output: unknown; resultExpiredAt?: never }>
              | Readonly<{ output?: never; resultExpiredAt: string }>
          ))
    | (StoredProcessRunBase &
          Readonly<{
              status: "failed";
              acceptedInput?: AcceptedProcessInput;
              startedAt: string;
              finishedAt: string;
          }> &
          (
              | Readonly<{ error: ProcessRunFailure; resultExpiredAt?: never }>
              | Readonly<{ error?: never; resultExpiredAt: string }>
          ));

export type AcceptedProcessRun = Readonly<{
    runId: string;
    ownerId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    process: string;
    version: string;
    acceptedInput: AcceptedProcessInput;
    createdAt: string;
}>;

export type ProcessRunAcceptance =
    | Readonly<{ outcome: "created"; run: StoredProcessRun }>
    | Readonly<{ outcome: "replayed"; run: StoredProcessRun }>
    | Readonly<{ outcome: "conflict" }>;

export type ClaimedProcessRun = Readonly<{
    runId: string;
    process: string;
    version: string;
    acceptedInput: AcceptedProcessInput;
    claimToken: string;
    attemptNumber: number;
}>;

export type ProcessRunAttemptCompletion =
    | Readonly<{ status: "succeeded"; output: unknown }>
    | Readonly<{ status: "failed"; error: ProcessRunFailure }>;

export type ProcessRunStore = Readonly<{
    accept: (run: AcceptedProcessRun) => Promise<ProcessRunAcceptance>;
    findOwned: (
        runId: string,
        ownerId: string,
    ) => Promise<StoredProcessRun | undefined>;
    claim: (request: {
        runId: string;
        claimToken: string;
        claimedAt: string;
    }) => Promise<ClaimedProcessRun | undefined>;
    complete: (request: {
        runId: string;
        claimToken: string;
        completedAt: string;
        completion: ProcessRunAttemptCompletion;
    }) => Promise<boolean>;
    scheduleRetry: (request: {
        runId: string;
        claimToken: string;
        scheduledAt: string;
        failure: ProcessRunFailure;
    }) => Promise<boolean>;
    releaseClaim: (request: {
        runId: string;
        claimToken: string;
        releasedAt: string;
    }) => Promise<boolean>;
}>;

export class ProcessRunStoreCapacityError extends Error {
    constructor() {
        super("Process Run Store is at capacity");
        this.name = "ProcessRunStoreCapacityError";
    }
}

export type ProcessRunBacklogScope = "caller" | "global";

export class ProcessRunBacklogLimitError extends Error {
    readonly scope: ProcessRunBacklogScope;
    readonly retryAfterSeconds: number;

    constructor(scope: ProcessRunBacklogScope, retryAfterSeconds: number) {
        super(
            `${scope === "caller" ? "Caller" : "Global"} Process Run backlog limit reached`,
        );
        this.name = "ProcessRunBacklogLimitError";
        this.scope = scope;
        this.retryAfterSeconds = positiveInteger(
            retryAfterSeconds,
            "Process Run backlog Retry-After",
        );
    }
}

export function createInMemoryProcessRunStore(
    options: { maxRuns?: number; claimLeaseMs?: number } = {},
): ProcessRunStore {
    const maxRuns = options.maxRuns ?? 100;
    if (!Number.isInteger(maxRuns) || maxRuns < 1) {
        throw new Error(
            "Process Run Store capacity must be a positive integer",
        );
    }
    const claimLeaseMs = positiveInteger(
        options.claimLeaseMs ?? 60_000,
        "Process Run claim lease",
    );

    const runs = new Map<string, StoredProcessRun>();
    const runIdsByOwnerAndKey = new Map<string, Map<string, string>>();

    return Object.freeze({
        accept: async (candidate): Promise<ProcessRunAcceptance> => {
            const ownerKeys = runIdsByOwnerAndKey.get(candidate.ownerId);
            const existingRunId = ownerKeys?.get(candidate.idempotencyKey);
            if (existingRunId !== undefined) {
                const existing = runs.get(existingRunId);
                if (!existing) {
                    throw new Error(
                        "Process Run Store idempotency index is inconsistent",
                    );
                }
                return existing.requestFingerprint ===
                    candidate.requestFingerprint
                    ? { outcome: "replayed", run: clone(existing) }
                    : { outcome: "conflict" };
            }
            if (runs.has(candidate.runId)) {
                throw new Error(
                    `Process Run ${candidate.runId} already exists`,
                );
            }
            if (runs.size >= maxRuns) {
                throw new ProcessRunStoreCapacityError();
            }

            const run: StoredProcessRun = clone({
                schemaVersion: 1,
                ...candidate,
                status: "queued",
                updatedAt: candidate.createdAt,
                attemptCount: 0,
                revision: 0,
            });
            let keys = ownerKeys;
            if (!keys) {
                keys = new Map();
                runIdsByOwnerAndKey.set(candidate.ownerId, keys);
            }
            runs.set(run.runId, run);
            keys.set(run.idempotencyKey, run.runId);
            return { outcome: "created", run: clone(run) };
        },

        findOwned: async (runId, ownerId) => {
            const run = runs.get(runId);
            return run?.ownerId === ownerId ? clone(run) : undefined;
        },

        claim: async (request) => {
            const run = runs.get(request.runId);
            if (
                !run ||
                (run.status !== "queued" &&
                    (run.status !== "running" ||
                        compareTimestamps(
                            run.claimExpiresAt,
                            request.claimedAt,
                        ) > 0))
            ) {
                return undefined;
            }

            const claimed: StoredProcessRun = {
                ...run,
                status: "running",
                claimToken: request.claimToken,
                claimExpiresAt: addMilliseconds(
                    request.claimedAt,
                    claimLeaseMs,
                ),
                startedAt: run.startedAt ?? request.claimedAt,
                updatedAt: request.claimedAt,
                attemptCount: run.attemptCount + 1,
                revision: run.revision + 1,
            };
            runs.set(run.runId, clone(claimed));
            return clone({
                runId: claimed.runId,
                process: claimed.process,
                version: claimed.version,
                acceptedInput: claimed.acceptedInput,
                claimToken: claimed.claimToken,
                attemptNumber: claimed.attemptCount,
            });
        },

        complete: async (request) => {
            const run = runs.get(request.runId);
            if (
                run?.status !== "running" ||
                run.claimToken !== request.claimToken
            ) {
                return false;
            }

            const terminal: StoredProcessRun =
                request.completion.status === "succeeded"
                    ? {
                          ...withoutClaim(run),
                          status: "succeeded",
                          finishedAt: request.completedAt,
                          updatedAt: request.completedAt,
                          output: clone(request.completion.output),
                          revision: run.revision + 1,
                      }
                    : {
                          ...withoutClaim(run),
                          status: "failed",
                          finishedAt: request.completedAt,
                          updatedAt: request.completedAt,
                          error: clone(request.completion.error),
                          revision: run.revision + 1,
                      };
            runs.set(run.runId, clone(terminal));
            return true;
        },

        scheduleRetry: async (request) => {
            const run = runs.get(request.runId);
            if (
                run?.status !== "running" ||
                run.claimToken !== request.claimToken
            ) {
                return false;
            }
            timestampMilliseconds(request.scheduledAt);
            const queued: StoredProcessRun = {
                ...withoutClaim(run),
                status: "queued",
                updatedAt: request.scheduledAt,
                revision: run.revision + 1,
            };
            runs.set(run.runId, clone(queued));
            return true;
        },

        releaseClaim: async (request) => {
            const run = runs.get(request.runId);
            if (
                run?.status !== "running" ||
                run.claimToken !== request.claimToken
            ) {
                return false;
            }
            const released: StoredProcessRun = {
                ...withoutClaim(run),
                status: "queued",
                updatedAt: request.releasedAt,
                revision: run.revision + 1,
            };
            runs.set(run.runId, clone(released));
            return true;
        },
    });
}

function withoutClaim(
    run: Extract<StoredProcessRun, { status: "running" }>,
): Omit<typeof run, "status" | "claimToken" | "claimExpiresAt"> {
    const {
        status: _status,
        claimToken: _claimToken,
        claimExpiresAt: _claimExpiresAt,
        ...rest
    } = run;
    return rest;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function addMilliseconds(timestamp: string, durationMs: number): string {
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time))
        throw new Error("Process Run timestamp is invalid");
    return new Date(time + durationMs).toISOString();
}

function compareTimestamps(left: string, right: string): number {
    const leftTime = new Date(left).getTime();
    const rightTime = new Date(right).getTime();
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
        throw new Error("Process Run timestamp is invalid");
    }
    return leftTime - rightTime;
}

function timestampMilliseconds(timestamp: string): number {
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time))
        throw new Error("Process Run timestamp is invalid");
    return time;
}

function clone<Value>(value: Value): Value {
    return structuredClone(value);
}
