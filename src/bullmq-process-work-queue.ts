import { Queue, Worker, type Job } from "bullmq";
import type { ProcessWorker, ProcessWorkResult } from "./process-worker.js";
import {
  parseProcessWorkJob,
  type ProcessWorkEnqueueResult,
  type ProcessWorkJob,
  type ProcessWorkQueue,
} from "./process-work-queue.js";

export const defaultProcessWorkQueueName = "process-runs";
export const defaultProcessWorkQueuePrefix = "pipipi";

const processWorkJobName = "process-run";
const defaultCompletedRetention = Object.freeze({ age: 3_600, count: 1_000 });
const defaultFailedRetention = Object.freeze({ age: 86_400, count: 5_000 });

export type BullMqProcessWorkQueue = ProcessWorkQueue &
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
      if (await queue.getJob(job.runId)) return "duplicate";
      await queue.add(processWorkJobName, job, { jobId: job.runId });
      return "enqueued";
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
  onError?: (error: Error) => void;
}): BullMqProcessWorker {
  const queueName = parseQueueName(options.queueName);
  const prefix = parseQueuePrefix(options.prefix);
  const concurrency = positiveInteger(
    options.concurrency ?? 1,
    "Process Worker concurrency",
  );
  const worker = new Worker<
    ProcessWorkJob,
    ProcessWorkResult,
    typeof processWorkJobName
  >(
    queueName,
    async (job: Job<ProcessWorkJob>) => {
      const parsed = parseProcessWorkJob(job.data);
      if (!parsed) throw new Error("Process Work Job is invalid");
      const result = await options.worker.process(parsed);
      if (result === "invalid-job") {
        throw new Error("Process Work Job is invalid");
      }
      return result;
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
      maxStalledCount: 1,
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
      await worker.waitUntilReady();
    },
    ready: () => worker.waitUntilReady(),
    close: async () => {
      if (closed) return;
      closed = true;
      await worker.close();
      worker.off("error", reportError);
      await runPromise;
    },
  });
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
