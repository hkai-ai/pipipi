/** 基于 BullMQ 实现 Webhook Work Queue 入队去重和 Delivery Worker 的并发消费与优雅关闭 */
import { type Job, Queue, Worker } from "bullmq";
import {
    type BullMqQueueSnapshot,
    readBullMqQueueSnapshot,
} from "../../process-runs/queue/observability.js";
import {
    parseWebhookDeliveryJob,
    type WebhookDeliveryJob,
} from "../delivery/job.js";
import type {
    WebhookDeliveryWorker,
    WebhookWorkResult,
} from "../delivery/worker.js";
import type { WebhookWorkEnqueueResult, WebhookWorkQueue } from "./index.js";

export const defaultWebhookWorkQueueName = "webhook-deliveries";
export const defaultWebhookWorkQueuePrefix = "pipipi";

const webhookJobName = "webhook-delivery";
const completedRetention = Object.freeze({ age: 3_600, count: 1_000 });
const failedRetention = Object.freeze({ age: 86_400, count: 5_000 });

export type BullMqWebhookWorkQueue = WebhookWorkQueue &
    Readonly<{
        ready: () => Promise<void>;
        snapshot: (asOfMilliseconds?: number) => Promise<BullMqQueueSnapshot>;
    }>;

export type BullMqWebhookWorker = Readonly<{
    start: () => Promise<void>;
    ready: () => Promise<void>;
    close: () => Promise<void>;
}>;

export function createBullMqWebhookWorkQueue(options: {
    redisUrl: string;
    queueName?: string;
    prefix?: string;
    connectTimeoutMs?: number;
    onError?: (error: Error) => void;
}): BullMqWebhookWorkQueue {
    const queueName = parseQueueName(options.queueName);
    const prefix = parseQueuePrefix(options.prefix);
    const queue = new Queue<
        WebhookDeliveryJob,
        WebhookWorkResult,
        typeof webhookJobName
    >(queueName, {
        connection: {
            url: parseRedisUrl(options.redisUrl),
            maxRetriesPerRequest: 1,
            connectTimeout: positiveInteger(
                options.connectTimeoutMs ?? 5_000,
                "Webhook Redis connection timeout",
            ),
        },
        prefix,
        skipWaitingForReady: true,
        defaultJobOptions: {
            attempts: 1,
            removeOnComplete: completedRetention,
            removeOnFail: failedRetention,
        },
        streams: { events: { maxLen: 1_000 } },
    });
    const reportError = options.onError ?? reportRedisError;
    queue.on("error", reportError);
    let closed = false;

    return Object.freeze({
        enqueue: async (rawJob): Promise<WebhookWorkEnqueueResult> => {
            if (closed) throw new Error("Webhook Work Queue is closed");
            const job = parseWebhookDeliveryJob(rawJob);
            if (!job) throw new Error("Webhook Delivery Job is invalid");
            const existing = await queue.getJob(job.deliveryId);
            if (existing) {
                const state = await existing.getState();
                if (state === "completed" || state === "failed") {
                    await existing.remove();
                } else {
                    return "duplicate";
                }
            }
            await queue.add(webhookJobName, job, { jobId: job.deliveryId });
            return "enqueued";
        },
        snapshot: async (asOfMilliseconds) => {
            if (closed) throw new Error("Webhook Work Queue is closed");
            return readBullMqQueueSnapshot(queue, asOfMilliseconds);
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

export function createBullMqWebhookWorker(options: {
    redisUrl: string;
    worker: WebhookDeliveryWorker;
    queueName?: string;
    prefix?: string;
    concurrency?: number;
    workerName?: string;
    shutdownGraceMs?: number;
    lockDurationMs?: number;
    stalledIntervalMs?: number;
    maxStalledCount?: number;
    onError?: (error: Error) => void;
}): BullMqWebhookWorker {
    const queueName = parseQueueName(options.queueName);
    const prefix = parseQueuePrefix(options.prefix);
    const concurrency = positiveInteger(
        options.concurrency ?? 4,
        "Webhook Worker concurrency",
    );
    const shutdownGraceMs = positiveInteger(
        options.shutdownGraceMs ?? 30_000,
        "Webhook Worker shutdown grace",
    );
    const activeDrainedWaiters = new Set<() => void>();
    let activeCount = 0;
    const worker = new Worker<
        WebhookDeliveryJob,
        WebhookWorkResult,
        typeof webhookJobName
    >(
        queueName,
        async (job: Job<WebhookDeliveryJob>, _token, signal) => {
            activeCount += 1;
            try {
                const parsed = parseWebhookDeliveryJob(job.data);
                if (!parsed) throw new Error("Webhook Delivery Job is invalid");
                const result = await options.worker.process(parsed, { signal });
                if (result === "invalid-job") {
                    throw new Error("Webhook Delivery Job is invalid");
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
            maxStalledCount: positiveInteger(
                options.maxStalledCount ?? 1,
                "Webhook Worker max stalled count",
            ),
            lockDuration: positiveInteger(
                options.lockDurationMs ?? 30_000,
                "Webhook Worker lock duration",
            ),
            stalledInterval: positiveInteger(
                options.stalledIntervalMs ?? 30_000,
                "Webhook Worker stalled interval",
            ),
            removeOnComplete: completedRetention,
            removeOnFail: failedRetention,
        },
    );
    const reportError = options.onError ?? reportRedisError;
    worker.on("error", reportError);
    let runPromise: Promise<void> | undefined;
    let closed = false;

    return Object.freeze({
        start: async () => {
            if (closed) throw new Error("Webhook Worker is closed");
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
            try {
                if (runPromise) {
                    await worker.pause(true);
                    forced = !(await waitForActiveToDrain(
                        () => activeCount,
                        activeDrainedWaiters,
                        shutdownGraceMs,
                    ));
                    if (forced)
                        worker.cancelAllJobs(
                            "Webhook Worker shutdown grace expired",
                        );
                }
            } finally {
                await worker.close(forced || !runPromise);
                if (runPromise && !forced) await runPromise;
                worker.off("error", reportError);
            }
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
        throw new Error(
            "Webhook Redis URL must be a valid redis:// or rediss:// URL",
        );
    }
    if (
        (url.protocol !== "redis:" && url.protocol !== "rediss:") ||
        url.hostname.length === 0
    ) {
        throw new Error(
            "Webhook Redis URL must be a valid redis:// or rediss:// URL",
        );
    }
    return candidate;
}

function parseQueueName(value: string | undefined): string {
    const name = value ?? defaultWebhookWorkQueueName;
    if (
        name.length === 0 ||
        name.length > 128 ||
        name.includes(":") ||
        !/^[a-zA-Z0-9_-]+$/.test(name)
    ) {
        throw new Error("Webhook Work Queue name is invalid");
    }
    return name;
}

function parseQueuePrefix(value: string | undefined): string {
    const prefix = value ?? defaultWebhookWorkQueuePrefix;
    if (
        prefix.length === 0 ||
        prefix.length > 128 ||
        !/^[a-zA-Z0-9:_-]+$/.test(prefix)
    ) {
        throw new Error("Webhook Work Queue prefix is invalid");
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
            event: "webhook_queue_error",
            timestamp: new Date().toISOString(),
        }),
    );
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error("Webhook Worker failed");
}
