import type {
  AcceptedProcessInput,
  ProcessErrorCode,
} from "./process-runtime.js";

export type ProcessRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

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
  acceptedInput: AcceptedProcessInput;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  revision: number;
}>;

export type StoredProcessRun =
  | (StoredProcessRunBase & Readonly<{ status: "queued" }>)
  | (StoredProcessRunBase &
      Readonly<{
        status: "running";
        claimToken: string;
        startedAt: string;
      }>)
  | (StoredProcessRunBase &
      Readonly<{
        status: "succeeded";
        startedAt: string;
        finishedAt: string;
        output: unknown;
      }>)
  | (StoredProcessRunBase &
      Readonly<{
        status: "failed";
        startedAt: string;
        finishedAt: string;
        error: ProcessRunFailure;
      }>);

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
}>;

export class ProcessRunStoreCapacityError extends Error {
  constructor() {
    super("Process Run Store is at capacity");
    this.name = "ProcessRunStoreCapacityError";
  }
}

export function createInMemoryProcessRunStore(
  options: { maxRuns?: number } = {},
): ProcessRunStore {
  const maxRuns = options.maxRuns ?? 100;
  if (!Number.isInteger(maxRuns) || maxRuns < 1) {
    throw new Error("Process Run Store capacity must be a positive integer");
  }

  const runs = new Map<string, StoredProcessRun>();
  const runIdsByOwnerAndKey = new Map<string, Map<string, string>>();

  return Object.freeze({
    accept: async (candidate): Promise<ProcessRunAcceptance> => {
      const ownerKeys = runIdsByOwnerAndKey.get(candidate.ownerId);
      const existingRunId = ownerKeys?.get(candidate.idempotencyKey);
      if (existingRunId !== undefined) {
        const existing = runs.get(existingRunId);
        if (!existing) {
          throw new Error("Process Run Store idempotency index is inconsistent");
        }
        return existing.requestFingerprint === candidate.requestFingerprint
          ? { outcome: "replayed", run: clone(existing) }
          : { outcome: "conflict" };
      }
      if (runs.has(candidate.runId)) {
        throw new Error(`Process Run ${candidate.runId} already exists`);
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
      if (!run || run.status !== "queued") return undefined;

      const claimed: StoredProcessRun = {
        ...run,
        status: "running",
        claimToken: request.claimToken,
        startedAt: request.claimedAt,
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
      });
    },

    complete: async (request) => {
      const run = runs.get(request.runId);
      if (
        !run ||
        run.status !== "running" ||
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
  });
}

function withoutClaim(
  run: Extract<StoredProcessRun, { status: "running" }>,
): Omit<typeof run, "status" | "claimToken"> {
  const { status: _status, claimToken: _claimToken, ...rest } = run;
  return rest;
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}
