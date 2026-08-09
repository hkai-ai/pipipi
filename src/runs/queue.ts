export type ProcessWorkJob = Readonly<{
  schemaVersion: 1;
  runId: string;
}>;

export type ProcessWorkEnqueueResult = "enqueued" | "duplicate";

export type ProcessWorkQueue = Readonly<{
  enqueue: (job: ProcessWorkJob) => Promise<ProcessWorkEnqueueResult>;
  close: () => Promise<void>;
}>;

export type ProcessWorkJobInspection = Readonly<{
  runId: string;
  state: "runnable" | "terminal" | "invalid" | "missing";
}>;

export type RecoverableProcessWorkQueue = ProcessWorkQueue &
  Readonly<{
    inspectJobs: (
      runIds: readonly string[],
    ) => Promise<readonly ProcessWorkJobInspection[]>;
  }>;

export type ProcessWorkSource = Readonly<{
  take: () => Promise<ProcessWorkJob | undefined>;
}>;

export type InMemoryProcessWorkQueue = RecoverableProcessWorkQueue &
  ProcessWorkSource;

export class ProcessWorkQueueCapacityError extends Error {
  constructor() {
    super("Process Work Queue is at capacity");
    this.name = "ProcessWorkQueueCapacityError";
  }
}

export function createInMemoryProcessWorkQueue(
  options: { maxJobs?: number } = {},
): InMemoryProcessWorkQueue {
  const maxJobs = options.maxJobs ?? 100;
  if (!Number.isInteger(maxJobs) || maxJobs < 1) {
    throw new Error("Process Work Queue capacity must be a positive integer");
  }

  const pendingJobs: ProcessWorkJob[] = [];
  const pendingRunIds = new Set<string>();
  let closed = false;

  return Object.freeze({
    enqueue: async (job) => {
      assertProcessWorkJob(job);
      if (closed) throw new Error("Process Work Queue is closed");
      if (pendingRunIds.has(job.runId)) return "duplicate";
      if (pendingJobs.length >= maxJobs) {
        throw new ProcessWorkQueueCapacityError();
      }
      const snapshot = structuredClone(job);
      pendingJobs.push(snapshot);
      pendingRunIds.add(snapshot.runId);
      return "enqueued";
    },
    take: async () => {
      const job = pendingJobs.shift();
      if (!job) return undefined;
      pendingRunIds.delete(job.runId);
      return structuredClone(job);
    },
    inspectJobs: async (runIds) => {
      assertInspectionRunIds(runIds);
      return runIds.map((runId) =>
        Object.freeze({
          runId,
          state: pendingRunIds.has(runId) ? "runnable" : "missing",
        }),
      );
    },
    close: async () => {
      closed = true;
    },
  });
}

export function parseProcessWorkJob(value: unknown): ProcessWorkJob | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.runId !== "string" ||
    candidate.runId.trim().length === 0 ||
    Buffer.byteLength(candidate.runId, "utf8") > 256
  ) {
    return undefined;
  }
  return Object.freeze({ schemaVersion: 1, runId: candidate.runId });
}

function assertProcessWorkJob(job: ProcessWorkJob): void {
  if (!parseProcessWorkJob(job)) {
    throw new Error("Process Work Job is invalid");
  }
}

export function assertInspectionRunIds(runIds: readonly string[]): void {
  if (runIds.length < 1 || runIds.length > 100) {
    throw new Error("Process Work Queue inspection requires 1 to 100 Run IDs");
  }
  const unique = new Set(runIds);
  if (
    unique.size !== runIds.length ||
    runIds.some(
      (runId) =>
        typeof runId !== "string" ||
        runId.trim().length === 0 ||
        Buffer.byteLength(runId, "utf8") > 256,
    )
  ) {
    throw new Error("Process Work Queue inspection Run IDs are invalid");
  }
}
