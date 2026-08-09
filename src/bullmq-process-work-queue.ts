import { DelayedError, Queue, Worker, type Job } from "bullmq";
import type { ProcessWorker, ProcessWorkResult } from "./process-worker.js";
import {
  parseProcessWorkJob,
  assertInspectionRunIds,
  type ProcessWorkEnqueueResult,
  type ProcessWorkJob,
  type RecoverableProcessWorkQueue,
} from "./process-work-queue.js";

export const defaultProcessWorkQueueName = "process-runs";
export const defaultProcessWorkQueuePrefix = "pipipi";

const processWorkJobName = "process-run";
const defaultCompletedRetention = Object.freeze({ age: 3_600, count: 1_000 });
const defaultFailedRetention = Object.freeze({ age: 86_400, count: 5_000 });

export type BullMqProcessWorkQueue = RecoverableProcessWorkQueue &
  Readonly<{
    ready: () => Promise<void>;
  }>;

export type BullMqProcessWorker = Readonly<{
  start: () => Promise<void>;
  ready: () => Promise<void>;
  close: () => Promise<void>;
}>;

export function createBullMqProcessWorkQueue(options: {
  redisUrl: string;
  queueName?: string;
  prefix?: string;
  connectTimeoutMs?: number;
  onError?: (error: Error) => void;
}): BullMqProcessWorkQueue {
  const queueName = parseQueueName(options.queueName);
  const prefix = parseQueuePrefix(options.prefix);
  const queue = new Queue<ProcessWorkJob, ProcessWorkResult, typeof processWorkJobName>(
    queueName,
    {
      connection: {
        url: parseRedisUrl(options.redisUrl),
        maxRetriesPerRequest: 1,
        connectTimeout: positiveInteger(
          options.connectTimeoutMs ?? 5_000,
          "Redis connection timeout",
        ),
      },
      prefix,
      skipWaitingForReady: true,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: defaultCompletedRetention,
        removeOnFail: defaultFailedRetention,
      },
      streams: { events: { maxLen: 1_000 } },
    },
  );
  const reportError = options.onError ?? reportRedisError;
  queue.on("error", reportError);
  let closed = false;

  return Object.freeze({
    enqueue: async (rawJob): Promise<ProcessWorkEnqueueResult> => {
      if (closed) throw new Error("Process Work Queue is closed");
      const job = parseProcessWorkJob(rawJob);
      if (!job) throw new Error("Process Work Job is invalid");
      const existing = await queue.getJob(job.runId);
      if (existing) {
        const state = await existing.getState();
        const existingJob = parseProcessWorkJob(existing.data);
        const validExistingJob = existingJob?.runId === job.runId;
        if (
          validExistingJob &&
          state !== "completed" &&
          state !== "failed" &&
          state !== "unknown"
        ) {
          return "duplicate";
        }
        if (state !== "unknown") {
          await existing.remove();
        }
      }
      await queue.add(processWorkJobName, job, { jobId: job.runId });
      return "enqueued";
    },
    inspectJobs: async (runIds) => {
      if (closed) throw new Error("Process Work Queue is closed");
      assertInspectionRunIds(runIds);
      return Promise.all(
        runIds.map(async (runId) => {
          const job = await queue.getJob(runId);
          if (!job) return Object.freeze({ runId, state: "missing" as const });
          const state = await job.getState();
          const parsed = parseProcessWorkJob(job.data);
          if (parsed?.runId !== runId) {
            return Object.freeze({ runId, state: "invalid" as const });
          }
          return Object.freeze({
            runId,
            state:
              state === "completed" || state === "failed"
                ? ("terminal" as const)
                : state === "unknown"
                  ? ("missing" as const)
                  : ("runnable" as const),
          });
        }),
      );
    },
    ready: () => queue.waitUntilReady(),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await queue.close();
      } finally {
        queue.off("error", reportError);
      }
    },
  });
}

export function createBullMqProcessWorker(options: {
  redisUrl: string;
  worker: ProcessWorker;
  queueName?: string;
  prefix?: string;
  concurrency?: number;
  workerName?: string;
  shutdownGraceMs?: number;
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  maxStalledCount?: number;
  clock?: () => string;
  onError?: (error: Error) => void;
}): BullMqProcessWorker {
  const queueName = parseQueueName(options.queueName);
  const prefix = parseQueuePrefix(options.prefix);
  const concurrency = positiveInteger(
    options.concurrency ?? 1,
    "Process Worker concurrency",
  );
  const shutdownGraceMs = positiveInteger(
    options.shutdownGraceMs ?? 30_000,
    "Process Worker shutdown grace",
  );
  const lockDuration = positiveInteger(
    options.lockDurationMs ?? 30_000,
    "Process Worker lock duration",
  );
  const stalledInterval = positiveInteger(
    options.stalledIntervalMs ?? 30_000,
    "Process Worker stalled interval",
  );
  const maxStalledCount = positiveInteger(
    options.maxStalledCount ?? 1,
    "Process Worker max stalled count",
  );
  const clock = options.clock ?? (() => new Date().toISOString());
  const activeDrainedWaiters = new Set<() => void>();
  let activeCount = 0;
  const worker = new Worker<
    ProcessWorkJob,
    ProcessWorkResult,
    typeof processWorkJobName
  >(
    queueName,
    async (job: Job<ProcessWorkJob>, token, signal) => {
      activeCount += 1;
      try {
        const parsed = parseProcessWorkJob(job.data);
        if (!parsed) throw new Error("Process Work Job is invalid");
        const result = await options.worker.process(parsed, { signal });
        if (result === "invalid-job") {
          throw new Error("Process Work Job is invalid");
        }
        if (typeof result === "object") {
          await job.moveToDelayed(Date.now() + result.delayMs, token);
          throw new DelayedError();
        }
        return result;
      } finally {
        activeCount -= 1;
        if (activeCount === 0) {
          for (const resolve of activeDrainedWaiters) resolve();
          activeDrainedWaiters.clear();
        }
      }
    },
    {
      connection: {
        url: parseRedisUrl(options.redisUrl),
        maxRetriesPerRequest: null,
      },
      prefix,
      autorun: false,
      concurrency,
      name: options.workerName,
      maxStalledCount,
      lockDuration,
      stalledInterval,
      removeOnComplete: defaultCompletedRetention,
      removeOnFail: defaultFailedRetention,
    },
  );
  const reportError = options.onError ?? reportRedisError;
  worker.on("error", reportError);
  let runPromise: Promise<void> | undefined;
  let closed = false;

  return Object.freeze({
    start: async () => {
      if (closed) throw new Error("Process Worker is closed");
      if (!runPromise) {
        runPromise = worker.run();
        void runPromise.catch((error: unknown) => {
          if (!closed) reportError(toError(error));
        });
      }
    },
    ready: () => worker.waitUntilReady(),
    close: async () => {
      if (closed) return;
      closed = true;
      let forced = false;
      let failure: unknown;
      try {
        if (runPromise) {
          await worker.pause(true);
          forced = !(await waitForActiveToDrain(
            () => activeCount,
            activeDrainedWaiters,
            shutdownGraceMs,
          ));
          if (forced) {
            await options.worker.releaseActive({
              releasedAt: clock(),
            });
            worker.cancelAllJobs("Process Worker shutdown grace expired");
          }
        }
      } catch (error) {
        failure = error;
        forced = true;
        worker.cancelAllJobs("Process Worker shutdown failed");
      }
      try {
        await worker.close(forced || !runPromise);
        if (!forced) await runPromise;
      } catch (error) {
        failure ??= error;
      } finally {
        worker.off("error", reportError);
      }
      if (failure) throw failure;
    },
  });
}

async function waitForActiveToDrain(
  activeCount: () => number,
  waiters: Set<() => void>,
  graceMs: number,
): Promise<boolean> {
  if (activeCount() === 0) return true;
  let resolveDrained: (() => void) | undefined;
  const drained = new Promise<true>((resolve) => {
    resolveDrained = () => resolve(true);
    waiters.add(resolveDrained);
    if (activeCount() === 0) resolveDrained();
  });
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), graceMs);
  });
  try {
    return await Promise.race([drained, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (resolveDrained) waiters.delete(resolveDrained);
  }
}

function parseRedisUrl(value: string): string {
  const candidate = value.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Redis URL must be a valid redis:// or rediss:// URL");
  }
  if (
    (url.protocol !== "redis:" && url.protocol !== "rediss:") ||
    url.hostname.length === 0
  ) {
    throw new Error("Redis URL must be a valid redis:// or rediss:// URL");
  }
  return candidate;
}

function parseQueueName(value: string | undefined): string {
  const name = value ?? defaultProcessWorkQueueName;
  if (
    name.length === 0 ||
    name.length > 128 ||
    name.includes(":") ||
    !/^[a-zA-Z0-9_-]+$/.test(name)
  ) {
    throw new Error("Process Work Queue name is invalid");
  }
  return name;
}

function parseQueuePrefix(value: string | undefined): string {
  const prefix = value ?? defaultProcessWorkQueuePrefix;
  if (
    prefix.length === 0 ||
    prefix.length > 128 ||
    !/^[a-zA-Z0-9:_-]+$/.test(prefix)
  ) {
    throw new Error("Process Work Queue prefix is invalid");
  }
  return prefix;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function reportRedisError(): void {
  console.error(
    JSON.stringify({
      event: "process_queue_error",
      timestamp: new Date().toISOString(),
    }),
  );
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Process Worker failed");
}
