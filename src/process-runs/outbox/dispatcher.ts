/** 从 Outbox 认领消息并投递到队列，成功标记已发布、失败释放认领（Process 与 Webhook Outbox 共用） */
import { randomUUID } from "node:crypto";
import type { WebhookOutbox } from "../../webhooks/outbox/index.js";
import type { WebhookWorkQueue } from "../../webhooks/queue/index.js";
import {
    type AsyncOperationalLogSink,
    emitAsyncOperationalLog,
} from "../ops/logging.js";
import type { ProcessWorkQueue } from "../queue/index.js";
import type { ProcessOutbox } from "./index.js";

export type OutboxDispatchResult = Readonly<{
    claimed: number;
    published: number;
    failed: number;
}>;

export type OutboxDispatcher = Readonly<{
    dispatchOnce: () => Promise<OutboxDispatchResult>;
}>;

export function createOutboxDispatcher(options: {
    outbox: ProcessOutbox;
    queue: ProcessWorkQueue;
    batchSize?: number;
    claimLeaseMs?: number;
    clock?: () => string;
    createClaimToken?: () => string;
    logSink?: AsyncOperationalLogSink;
}): OutboxDispatcher {
    return createOutboxRelay({
        claim: options.outbox.claimProcessWork,
        enqueue: (message) => options.queue.enqueue(message.job),
        markPublished: options.outbox.markPublished,
        release: options.outbox.release,
        batchSize: options.batchSize,
        claimLeaseMs: options.claimLeaseMs,
        clock: options.clock,
        createClaimToken: options.createClaimToken,
        topic: "process-runs",
        logSink: options.logSink,
    });
}

export function createWebhookOutboxDispatcher(options: {
    outbox: WebhookOutbox;
    queue: WebhookWorkQueue;
    batchSize?: number;
    claimLeaseMs?: number;
    clock?: () => string;
    createClaimToken?: () => string;
    logSink?: AsyncOperationalLogSink;
}): OutboxDispatcher {
    return createOutboxRelay({
        claim: options.outbox.claimWebhookWork,
        enqueue: (message) => options.queue.enqueue(message.job),
        markPublished: options.outbox.markPublished,
        release: options.outbox.release,
        batchSize: options.batchSize,
        claimLeaseMs: options.claimLeaseMs,
        clock: options.clock,
        createClaimToken: options.createClaimToken,
        topic: "webhook-deliveries",
        logSink: options.logSink,
    });
}

function createOutboxRelay<
    Message extends Readonly<{
        messageId: string;
        eventId: string;
        claimToken: string;
        job: Readonly<{ runId: string }> | Readonly<{ deliveryId: string }>;
    }>,
>(options: {
    claim: (request: {
        limit: number;
        claimToken: string;
        claimedAt: string;
        claimExpiresAt: string;
    }) => Promise<readonly Message[]>;
    enqueue: (message: Message) => Promise<unknown>;
    markPublished: (request: {
        messageId: string;
        claimToken: string;
        publishedAt: string;
    }) => Promise<boolean>;
    release: (request: {
        messageId: string;
        claimToken: string;
    }) => Promise<boolean>;
    batchSize?: number;
    claimLeaseMs?: number;
    clock?: () => string;
    createClaimToken?: () => string;
    topic: "process-runs" | "webhook-deliveries";
    logSink?: AsyncOperationalLogSink;
}): OutboxDispatcher {
    const batchSize = positiveInteger(
        options.batchSize ?? 25,
        "Outbox batch size",
    );
    if (batchSize > 100) {
        throw new Error("Outbox batch size must not exceed 100");
    }
    const claimLeaseMs = positiveInteger(
        options.claimLeaseMs ?? 30_000,
        "Outbox claim lease",
    );
    const clock = options.clock ?? (() => new Date().toISOString());
    const createClaimToken = options.createClaimToken ?? randomUUID;

    return Object.freeze({
        dispatchOnce: async () => {
            const claimedAt = clock();
            const messages = await options.claim({
                limit: batchSize,
                claimToken: createClaimToken(),
                claimedAt,
                claimExpiresAt: addMilliseconds(claimedAt, claimLeaseMs),
            });
            let published = 0;
            let failed = 0;
            for (const message of messages) {
                try {
                    await options.enqueue(message);
                    const publishedAt = clock();
                    const marked = await options.markPublished({
                        messageId: message.messageId,
                        claimToken: message.claimToken,
                        publishedAt,
                    });
                    if (!marked)
                        throw new Error("Outbox publish claim was lost");
                    published += 1;
                    emitAsyncOperationalLog(options.logSink, {
                        event: "outbox_message_published",
                        topic: options.topic,
                        timestamp: publishedAt,
                        messageId: message.messageId,
                        eventId: message.eventId,
                        ...messageCorrelation(message.job),
                    });
                } catch {
                    failed += 1;
                    emitAsyncOperationalLog(options.logSink, {
                        event: "outbox_message_publish_failed",
                        topic: options.topic,
                        timestamp: claimedAt,
                        messageId: message.messageId,
                        eventId: message.eventId,
                        ...messageCorrelation(message.job),
                    });
                    await options.release({
                        messageId: message.messageId,
                        claimToken: message.claimToken,
                    });
                }
            }
            return Object.freeze({
                claimed: messages.length,
                published,
                failed,
            });
        },
    });
}

function messageCorrelation(
    job: Readonly<{ runId: string }> | Readonly<{ deliveryId: string }>,
): Readonly<{ runId: string }> | Readonly<{ deliveryId: string }> {
    return "runId" in job
        ? { runId: job.runId }
        : { deliveryId: job.deliveryId };
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function addMilliseconds(timestamp: string, durationMs: number): string {
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time)) throw new Error("Outbox timestamp is invalid");
    return new Date(time + durationMs).toISOString();
}
