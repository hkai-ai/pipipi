export type BullMqQueueSnapshot = Readonly<{
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  failed: number;
  completed: number;
  waitingChildren: number;
  oldestRunnableAgeMs: number;
}>;

type ObservableBullMqQueue = Readonly<{
  getJobCounts: (...states: ObservedState[]) => Promise<Record<string, number>>;
  getJobs: (
    states: RunnableState[],
    start: number,
    end: number,
    ascending: boolean,
  ) => Promise<readonly Readonly<{ timestamp: number }>[] >;
}>;

type ObservedState =
  | "waiting"
  | "active"
  | "delayed"
  | "prioritized"
  | "failed"
  | "completed"
  | "waiting-children";

type RunnableState = Exclude<ObservedState, "failed" | "completed">;

const countedStates = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "failed",
  "completed",
  "waiting-children",
] as const;

const runnableStates = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
] as const;

export async function readBullMqQueueSnapshot(
  queue: ObservableBullMqQueue,
  asOfMilliseconds: number = Date.now(),
): Promise<BullMqQueueSnapshot> {
  if (!Number.isFinite(asOfMilliseconds) || asOfMilliseconds < 0) {
    throw new Error("BullMQ observation timestamp is invalid");
  }
  const [counts, oldestJobs] = await Promise.all([
    queue.getJobCounts(...countedStates),
    queue.getJobs([...runnableStates], 0, 0, true),
  ]);
  const oldestTimestamp = oldestJobs.reduce<number | undefined>(
    (oldest, job) => {
      if (!Number.isFinite(job.timestamp) || job.timestamp < 0) {
        throw new Error("BullMQ Job timestamp is invalid");
      }
      return oldest === undefined
        ? job.timestamp
        : Math.min(oldest, job.timestamp);
    },
    undefined,
  );
  return Object.freeze({
    waiting: queueCount(counts.waiting, "waiting"),
    active: queueCount(counts.active, "active"),
    delayed: queueCount(counts.delayed, "delayed"),
    prioritized: queueCount(counts.prioritized, "prioritized"),
    failed: queueCount(counts.failed, "failed"),
    completed: queueCount(counts.completed, "completed"),
    waitingChildren: queueCount(counts["waiting-children"], "waiting-children"),
    oldestRunnableAgeMs:
      oldestTimestamp === undefined
        ? 0
        : Math.max(0, Math.round(asOfMilliseconds - oldestTimestamp)),
  });
}

function queueCount(value: number | undefined, state: string): number {
  const count = value ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`BullMQ ${state} count is invalid`);
  }
  return count;
}
