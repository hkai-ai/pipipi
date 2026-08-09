import { randomUUID } from "node:crypto";
import {
    type AsyncOperationalLogSink,
    emitAsyncOperationalLog,
    tryOperationalTimestamp,
} from "../../process-runs/ops/logging.js";
import type { WebhookSender, WebhookSendResult } from "./http.js";
import { parseWebhookDeliveryJob } from "./job.js";

export type ClaimedWebhookDelivery = Readonly<{
    deliveryId: string;
    eventId: string;
    endpointId: string;
    endpointUrl: string;
    secrets: readonly string[];
    payload: string;
    claimToken: string;
    attemptNumber: number;
    createdAt: string;
}>;

export type WebhookDeliveryStore = Readonly<{
    claim: (request: {
        deliveryId: string;
        claimToken: string;
        claimedAt: string;
    }) => Promise<ClaimedWebhookDelivery | undefined>;
    complete: (request: {
        deliveryId: string;
        claimToken: string;
        completedAt: string;
        result: WebhookSendResult;
        terminalStatus?: "failed" | "exhausted";
        disableEndpoint?: boolean;
    }) => Promise<boolean>;
    reschedule: (request: {
        deliveryId: string;
        claimToken: string;
        completedAt: string;
        nextAttemptAt: string;
        result: Extract<WebhookSendResult, { outcome: "failed" }>;
    }) => Promise<boolean>;
}>;

export type WebhookWorkResult =
    | "processed"
    | "ignored"
    | "invalid-job"
    | Readonly<{ outcome: "retry-scheduled"; delayMs: number }>;

export type WebhookDeliveryWorker = Readonly<{
    process: (
        job: unknown,
        context?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<WebhookWorkResult>;
}>;

export type WebhookRetryPolicy = Readonly<{
    maximumAttempts: number;
    initialBackoffMs: number;
    maximumBackoffMs: number;
    maximumRetryAfterMs: number;
    deliveryHorizonMs: number;
    jitterPercent: number;
}>;

export function createWebhookDeliveryWorker(options: {
    store: WebhookDeliveryStore;
    sender: WebhookSender;
    clock?: () => string;
    createClaimToken?: () => string;
    retryPolicy?: WebhookRetryPolicy;
    random?: () => number;
    logSink?: AsyncOperationalLogSink;
    logClock?: () => string;
}): WebhookDeliveryWorker {
    const clock = options.clock ?? (() => new Date().toISOString());
    const createClaimToken = options.createClaimToken ?? randomUUID;
    const retryPolicy = validateRetryPolicy(
        options.retryPolicy ?? {
            maximumAttempts: 8,
            initialBackoffMs: 5_000,
            maximumBackoffMs: 86_400_000,
            maximumRetryAfterMs: 86_400_000,
            deliveryHorizonMs: 259_200_000,
            jitterPercent: 20,
        },
    );
    const random = options.random ?? Math.random;
    const logClock = options.logClock ?? (() => new Date().toISOString());

    return Object.freeze({
        process: async (rawJob, context) => {
            const job = parseWebhookDeliveryJob(rawJob);
            if (!job) return "invalid-job";
            const claimToken = createClaimToken();
            const delivery = await options.store.claim({
                deliveryId: job.deliveryId,
                claimToken,
                claimedAt: clock(),
            });
            if (!delivery) return "ignored";

            let result: WebhookSendResult;
            try {
                result = await options.sender.send({
                    url: delivery.endpointUrl,
                    eventId: delivery.eventId,
                    payload: delivery.payload,
                    secrets: delivery.secrets,
                    ...(context?.signal ? { signal: context.signal } : {}),
                });
            } catch (error) {
                const timestamp = tryOperationalTimestamp(logClock);
                if (timestamp) {
                    emitWebhookAttempt(options.logSink, delivery, timestamp, {
                        outcome: "failed",
                        disposition: "worker_error",
                    });
                }
                throw error;
            }
            const completedAt = clock();
            if (result.outcome === "failed" && isRetryable(result)) {
                const delayMs = retryDelay(
                    retryPolicy,
                    delivery.attemptNumber,
                    result.retryAfterMs,
                    random,
                );
                const nextAttemptAt = addMilliseconds(completedAt, delayMs);
                if (
                    delivery.attemptNumber < retryPolicy.maximumAttempts &&
                    timestampMilliseconds(nextAttemptAt) <=
                        timestampMilliseconds(delivery.createdAt) +
                            retryPolicy.deliveryHorizonMs
                ) {
                    const rescheduled = await options.store.reschedule({
                        deliveryId: delivery.deliveryId,
                        claimToken: delivery.claimToken,
                        completedAt,
                        nextAttemptAt,
                        result,
                    });
                    const disposition = rescheduled
                        ? "retry_scheduled"
                        : "claim_lost";
                    emitWebhookAttempt(options.logSink, delivery, completedAt, {
                        outcome: "failed",
                        disposition,
                        ...(result.httpStatus === undefined
                            ? {}
                            : { httpStatus: result.httpStatus }),
                        errorCode: result.errorCode,
                    });
                    return rescheduled
                        ? { outcome: "retry-scheduled", delayMs }
                        : "ignored";
                }
            }
            const completed = await options.store.complete({
                deliveryId: delivery.deliveryId,
                claimToken: delivery.claimToken,
                completedAt,
                result,
                ...(result.outcome === "failed"
                    ? {
                          terminalStatus: isRetryable(result)
                              ? "exhausted"
                              : "failed",
                          disableEndpoint:
                              result.httpStatus === 410 ||
                              result.errorCode === "TARGET_REJECTED",
                      }
                    : {}),
            });
            emitWebhookAttempt(options.logSink, delivery, completedAt, {
                outcome: result.outcome,
                disposition: completed ? "completed" : "claim_lost",
                ...(result.httpStatus === undefined
                    ? {}
                    : { httpStatus: result.httpStatus }),
                ...(result.outcome === "failed"
                    ? { errorCode: result.errorCode }
                    : {}),
            });
            return completed ? "processed" : "ignored";
        },
    });
}

function emitWebhookAttempt(
    sink: AsyncOperationalLogSink | undefined,
    delivery: ClaimedWebhookDelivery,
    timestamp: string,
    result: Readonly<{
        outcome: "succeeded" | "failed";
        disposition:
            | "completed"
            | "retry_scheduled"
            | "claim_lost"
            | "worker_error";
        httpStatus?: number;
        errorCode?: "HTTP_ERROR" | "NETWORK_ERROR" | "TARGET_REJECTED";
    }>,
): void {
    emitAsyncOperationalLog(sink, {
        event: "webhook_delivery_attempt_finished",
        timestamp,
        deliveryId: delivery.deliveryId,
        eventId: delivery.eventId,
        attemptNumber: delivery.attemptNumber,
        ...result,
    });
}

function isRetryable(
    result: Extract<WebhookSendResult, { outcome: "failed" }>,
): boolean {
    return (
        result.errorCode === "NETWORK_ERROR" ||
        result.httpStatus === 429 ||
        (result.httpStatus !== undefined && result.httpStatus >= 500)
    );
}

function retryDelay(
    policy: WebhookRetryPolicy,
    attemptNumber: number,
    retryAfterMs: number | undefined,
    random: () => number,
): number {
    const randomValue = random();
    if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
        throw new Error("Webhook retry random value must be between 0 and 1");
    }
    const base = Math.min(
        policy.initialBackoffMs * 2 ** (attemptNumber - 1),
        policy.maximumBackoffMs,
    );
    const jitter = Math.round(
        (base * ((randomValue * 2 - 1) * policy.jitterPercent)) / 100,
    );
    const backoff = Math.max(1, base + jitter);
    return retryAfterMs === undefined
        ? backoff
        : Math.max(backoff, Math.min(retryAfterMs, policy.maximumRetryAfterMs));
}

function validateRetryPolicy(policy: WebhookRetryPolicy): WebhookRetryPolicy {
    const maximumAttempts = boundedInteger(
        policy.maximumAttempts,
        1,
        20,
        "Webhook retry maximum attempts",
    );
    const initialBackoffMs = boundedInteger(
        policy.initialBackoffMs,
        1,
        maximumWebhookDurationMs,
        "Webhook retry initial backoff",
    );
    const maximumBackoffMs = boundedInteger(
        policy.maximumBackoffMs,
        1,
        maximumWebhookDurationMs,
        "Webhook retry maximum backoff",
    );
    if (maximumBackoffMs < initialBackoffMs) {
        throw new Error(
            "Webhook retry maximum backoff must not be below its initial backoff",
        );
    }
    return Object.freeze({
        maximumAttempts,
        initialBackoffMs,
        maximumBackoffMs,
        maximumRetryAfterMs: boundedInteger(
            policy.maximumRetryAfterMs,
            1,
            maximumWebhookDurationMs,
            "Webhook maximum Retry-After",
        ),
        deliveryHorizonMs: boundedInteger(
            policy.deliveryHorizonMs,
            1,
            maximumWebhookDurationMs,
            "Webhook delivery horizon",
        ),
        jitterPercent: boundedInteger(
            policy.jitterPercent,
            0,
            100,
            "Webhook retry jitter percent",
        ),
    });
}

const maximumWebhookDurationMs = 31 * 24 * 60 * 60 * 1_000;

function addMilliseconds(timestamp: string, durationMs: number): string {
    return new Date(
        timestampMilliseconds(timestamp) + durationMs,
    ).toISOString();
}

function timestampMilliseconds(timestamp: string): number {
    const value = new Date(timestamp).getTime();
    if (!Number.isFinite(value))
        throw new Error("Webhook timestamp is invalid");
    return value;
}

function boundedInteger(
    value: number,
    minimum: number,
    maximum: number,
    label: string,
): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${label} must be between ${minimum} and ${maximum}`);
    }
    return value;
}
