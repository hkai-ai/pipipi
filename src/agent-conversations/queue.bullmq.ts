/** 用 BullMQ 投递最小 Agent Turn Job，并把 Redis Worker 连接到受 fencing 保护的 Worker */
import { type Job, Queue, Worker } from "bullmq";
import {
    type AgentTurnJob,
    assertInspectionTurnIds,
    parseAgentTurnJob,
    type RecoverableAgentTurnQueue,
} from "./queue.js";
import type { AgentTurnWorker } from "./worker.js";

export const defaultAgentTurnQueueName = "agent-turns";
export const defaultAgentTurnQueuePrefix = "pipipi";

const agentTurnJobName = "agent-turn";
const completedRetention = Object.freeze({ age: 3_600, count: 1_000 });
const failedRetention = Object.freeze({ age: 86_400, count: 5_000 });

export type BullMqAgentTurnQueue = RecoverableAgentTurnQueue &
    Readonly<{ ready: () => Promise<void> }>;

export type BullMqAgentTurnWorker = Readonly<{
    start: () => Promise<void>;
    ready: () => Promise<void>;
    close: () => Promise<void>;
}>;

export function createBullMqAgentTurnQueue(options: {
    redisUrl: string;
    queueName?: string;
    prefix?: string;
    connectTimeoutMs?: number;
    onError?: (error: Error) => void;
}): BullMqAgentTurnQueue {
    const queueName = parseQueueName(options.queueName);
    const prefix = parseQueuePrefix(options.prefix);
    const queue = new Queue<AgentTurnJob, string, typeof agentTurnJobName>(
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
                removeOnComplete: completedRetention,
                removeOnFail: failedRetention,
            },
            streams: { events: { maxLen: 1_000 } },
        },
    );
    const reportError = options.onError ?? reportRedisError;
    queue.on("error", reportError);
    let closed = false;

    return Object.freeze({
        enqueue: async (rawJob) => {
            if (closed) throw new Error("Agent Turn Queue is closed");
            const job = parseAgentTurnJob(rawJob);
            if (!job) throw new Error("Agent Turn Job is invalid");
            const existing = await queue.getJob(job.turnId);
            if (existing) {
                const state = await existing.getState();
                const parsed = parseAgentTurnJob(existing.data);
                if (
                    parsed?.turnId === job.turnId &&
                    state !== "completed" &&
                    state !== "failed" &&
                    state !== "unknown"
                ) {
                    return "duplicate";
                }
                if (state !== "unknown") await existing.remove();
            }
            await queue.add(agentTurnJobName, job, { jobId: job.turnId });
            return "enqueued";
        },
        inspectJobs: async (turnIds) => {
            if (closed) throw new Error("Agent Turn Queue is closed");
            assertInspectionTurnIds(turnIds);
            return Promise.all(
                turnIds.map(async (turnId) => {
                    const job = await queue.getJob(turnId);
                    if (!job) {
                        return Object.freeze({
                            turnId,
                            state: "missing" as const,
                        });
                    }
                    const state = await job.getState();
                    const parsed = parseAgentTurnJob(job.data);
                    if (parsed?.turnId !== turnId) {
                        return Object.freeze({
                            turnId,
                            state: "invalid" as const,
                        });
                    }
                    return Object.freeze({
                        turnId,
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

export function createBullMqAgentTurnWorker(options: {
    redisUrl: string;
    worker: AgentTurnWorker;
    queueName?: string;
    prefix?: string;
    concurrency?: number;
    workerName?: string;
    shutdownGraceMs?: number;
    lockDurationMs?: number;
    stalledIntervalMs?: number;
    maxStalledCount?: number;
    dependenciesReady?: () => Promise<void>;
    clock?: () => string;
    onError?: (error: Error) => void;
}): BullMqAgentTurnWorker {
    const queueName = parseQueueName(options.queueName);
    const prefix = parseQueuePrefix(options.prefix);
    const shutdownGraceMs = positiveInteger(
        options.shutdownGraceMs ?? 30_000,
        "Agent Turn Worker shutdown grace",
    );
    const clock = options.clock ?? (() => new Date().toISOString());
    const waiters = new Set<() => void>();
    let activeCount = 0;
    const worker = new Worker<AgentTurnJob, string, typeof agentTurnJobName>(
        queueName,
        async (job: Job<AgentTurnJob>, _token, signal) => {
            activeCount += 1;
            try {
                const parsed = parseAgentTurnJob(job.data);
                if (!parsed) throw new Error("Agent Turn Job is invalid");
                const result = await options.worker.process(parsed, { signal });
                if (result === "invalid-job") {
                    throw new Error("Agent Turn Job is invalid");
                }
                return result;
            } finally {
                activeCount -= 1;
                if (activeCount === 0) {
                    for (const resolve of waiters) resolve();
                    waiters.clear();
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
            concurrency: positiveInteger(
                options.concurrency ?? 1,
                "Agent Turn Worker concurrency",
            ),
            name: options.workerName,
            maxStalledCount: positiveInteger(
                options.maxStalledCount ?? 1,
                "Agent Turn Worker max stalled count",
            ),
            lockDuration: positiveInteger(
                options.lockDurationMs ?? 30_000,
                "Agent Turn Worker lock duration",
            ),
            stalledInterval: positiveInteger(
                options.stalledIntervalMs ?? 30_000,
                "Agent Turn Worker stalled interval",
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
            if (closed) throw new Error("Agent Turn Worker is closed");
            if (!runPromise) {
                runPromise = worker.run();
                void runPromise.catch((error: unknown) => {
                    if (!closed) reportError(toError(error));
                });
            }
        },
        ready: async () => {
            await Promise.all([
                worker.waitUntilReady(),
                options.dependenciesReady?.(),
            ]);
        },
        close: async () => {
            if (closed) return;
            closed = true;
            let forceClose = false;
            let failure: unknown;
            try {
                if (runPromise) {
                    await worker.pause(true);
                    const drained = await waitForActiveToDrain(
                        () => activeCount,
                        waiters,
                        shutdownGraceMs,
                    );
                    if (!drained) {
                        await options.worker.releaseActive({
                            releasedAt: clock(),
                        });
                        worker.cancelAllJobs(
                            "Agent Turn Worker shutdown grace expired",
                        );
                        forceClose = !(await waitForActiveToDrain(
                            () => activeCount,
                            waiters,
                            shutdownGraceMs,
                        ));
                    }
                }
            } catch (error) {
                failure = error;
                forceClose = true;
                worker.cancelAllJobs("Agent Turn Worker shutdown failed");
            }
            try {
                await worker.close(forceClose || !runPromise);
                if (!forceClose) await runPromise;
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
    const name = value ?? defaultAgentTurnQueueName;
    if (
        name.length === 0 ||
        name.length > 128 ||
        name.includes(":") ||
        !/^[a-zA-Z0-9_-]+$/.test(name)
    ) {
        throw new Error("Agent Turn Queue name is invalid");
    }
    return name;
}

function parseQueuePrefix(value: string | undefined): string {
    const prefix = value ?? defaultAgentTurnQueuePrefix;
    if (
        prefix.length === 0 ||
        prefix.length > 128 ||
        !/^[a-zA-Z0-9:_-]+$/.test(prefix)
    ) {
        throw new Error("Agent Turn Queue prefix is invalid");
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
            event: "agent_turn_queue_error",
            timestamp: new Date().toISOString(),
        }),
    );
}

function toError(value: unknown): Error {
    return value instanceof Error
        ? value
        : new Error("Agent Turn Worker failed");
}
