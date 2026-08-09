import { createHmac, randomUUID } from "node:crypto";
import {
  createPinnedWebhookHttpClient,
  createWebhookTargetPolicy,
  isWebhookTargetPolicyError,
  type WebhookHttpClient,
  type WebhookTargetPolicy,
  type WebhookTargetRejectionCode,
} from "./webhook-target-policy.js";

export type WebhookDeliveryJob = Readonly<{
  schemaVersion: 1;
  deliveryId: string;
}>;

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

export type WebhookSendResult =
  | Readonly<{
      outcome: "succeeded";
      httpStatus: number;
      latencyMs: number;
    }>
  | Readonly<{
      outcome: "failed";
      errorCode: "HTTP_ERROR" | "NETWORK_ERROR" | "TARGET_REJECTED";
      httpStatus?: number;
      retryAfterMs?: number;
      targetRejectionCode?: WebhookTargetRejectionCode;
      latencyMs: number;
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

export type WebhookSender = Readonly<{
  send: (request: {
    url: string;
    eventId: string;
    payload: string;
    secrets: readonly string[];
    signal?: AbortSignal;
  }) => Promise<WebhookSendResult>;
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

      const result = await options.sender.send({
        url: delivery.endpointUrl,
        eventId: delivery.eventId,
        payload: delivery.payload,
        secrets: delivery.secrets,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
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
              terminalStatus: isRetryable(result) ? "exhausted" : "failed",
              disableEndpoint:
                result.httpStatus === 410 || result.errorCode === "TARGET_REJECTED",
            }
          : {}),
      });
      return completed ? "processed" : "ignored";
    },
  });
}

export function parseWebhookDeliveryJob(
  value: unknown,
): WebhookDeliveryJob | undefined {
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
    typeof candidate.deliveryId !== "string" ||
    candidate.deliveryId.trim().length === 0 ||
    Buffer.byteLength(candidate.deliveryId, "utf8") > 256
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: 1,
    deliveryId: candidate.deliveryId,
  });
}

export function signStandardWebhook(request: {
  messageId: string;
  timestamp: string;
  payload: string;
  secret: string;
}): string {
  if (
    request.messageId.length === 0 ||
    request.messageId.includes(".") ||
    request.timestamp.length === 0 ||
    request.timestamp.includes(".")
  ) {
    throw new Error("Webhook signing metadata is invalid");
  }
  const key = parseWebhookSecret(request.secret);
  const signature = createHmac("sha256", key)
    .update(`${request.messageId}.${request.timestamp}.${request.payload}`)
    .digest("base64");
  return `v1,${signature}`;
}

export function assertStandardWebhookSecret(secret: string): void {
  parseWebhookSecret(secret);
}

export function createStandardWebhookHttpSender(options: {
  timeoutMs?: number;
  clock?: () => string;
  targetPolicy?: WebhookTargetPolicy;
  httpClient?: WebhookHttpClient;
} = {}): WebhookSender {
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? 20_000,
    "Webhook request timeout",
  );
  const clock = options.clock ?? (() => new Date().toISOString());
  const httpClient =
    options.httpClient ??
    createPinnedWebhookHttpClient({
      targetPolicy: options.targetPolicy ?? createWebhookTargetPolicy(),
    });

  return Object.freeze({
    send: async (request): Promise<WebhookSendResult> => {
      if (request.secrets.length < 1 || request.secrets.length > 2) {
        throw new Error("Webhook Delivery requires one or two signing secrets");
      }
      if (Buffer.byteLength(request.payload, "utf8") > 20_480) {
        throw new Error("Webhook payload must not exceed 20480 UTF-8 bytes");
      }
      const attemptedAt = clock();
      const timestamp = webhookTimestamp(attemptedAt);
      const signatures = request.secrets.map((secret) =>
        signStandardWebhook({
          messageId: request.eventId,
          timestamp,
          payload: request.payload,
          secret,
        }),
      );
      const startedAt = performance.now();
      try {
        const response = await httpClient.post({
          url: request.url,
          headers: {
            "content-type": "application/json",
            "webhook-id": request.eventId,
            "webhook-timestamp": timestamp,
            "webhook-signature": signatures.join(" "),
          },
          body: request.payload,
          signal: request.signal
            ? AbortSignal.any([
                request.signal,
                AbortSignal.timeout(timeoutMs),
              ])
            : AbortSignal.timeout(timeoutMs),
        });
        const latencyMs = elapsedMilliseconds(startedAt);
        if (response.status < 100 || response.status > 599) {
          return Object.freeze({
            outcome: "failed",
            errorCode: "NETWORK_ERROR",
            latencyMs,
          });
        }
        return response.status >= 200 && response.status <= 299
          ? Object.freeze({
              outcome: "succeeded",
              httpStatus: response.status,
              latencyMs,
            })
          : Object.freeze({
              outcome: "failed",
              errorCode: "HTTP_ERROR",
              httpStatus: response.status,
              ...retryAfter(response.retryAfter, attemptedAt),
              latencyMs,
            });
      } catch (error) {
        if (isWebhookTargetPolicyError(error)) {
          if (error.code === "WEBHOOK_TARGET_DNS_FAILED") {
            return Object.freeze({
              outcome: "failed",
              errorCode: "NETWORK_ERROR",
              latencyMs: elapsedMilliseconds(startedAt),
            });
          }
          return Object.freeze({
            outcome: "failed",
            errorCode: "TARGET_REJECTED",
            targetRejectionCode: error.code,
            latencyMs: elapsedMilliseconds(startedAt),
          });
        }
        return Object.freeze({
          outcome: "failed",
          errorCode: "NETWORK_ERROR",
          latencyMs: elapsedMilliseconds(startedAt),
        });
      }
    },
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
    base * ((randomValue * 2 - 1) * policy.jitterPercent) / 100,
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
    throw new Error("Webhook retry maximum backoff must not be below its initial backoff");
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

function retryAfter(
  value: string | null,
  attemptedAt: string,
): Readonly<{ retryAfterMs?: number }> {
  if (value === null) return Object.freeze({});
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const milliseconds = seconds * 1_000;
    if (Number.isSafeInteger(milliseconds)) {
      return Object.freeze({ retryAfterMs: milliseconds });
    }
    return Object.freeze({});
  }
  const target = Date.parse(trimmed);
  const attempted = timestampMilliseconds(attemptedAt);
  return Number.isFinite(target) && target >= attempted
    ? Object.freeze({ retryAfterMs: target - attempted })
    : Object.freeze({});
}

function addMilliseconds(timestamp: string, durationMs: number): string {
  return new Date(timestampMilliseconds(timestamp) + durationMs).toISOString();
}

function timestampMilliseconds(timestamp: string): number {
  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) throw new Error("Webhook timestamp is invalid");
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

function parseWebhookSecret(secret: string): Buffer {
  if (!secret.startsWith("whsec_")) {
    throw new Error("Webhook secret must use whsec_ base64 encoding");
  }
  const encoded = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("Webhook secret must use whsec_ base64 encoding");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64") !== encoded) {
    throw new Error("Webhook secret must use whsec_ base64 encoding");
  }
  return key;
}

function webhookTimestamp(value: string): string {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Webhook attempt timestamp is invalid");
  }
  return Math.floor(milliseconds / 1_000).toString();
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
