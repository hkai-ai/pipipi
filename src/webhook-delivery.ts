import { createHmac, randomUUID } from "node:crypto";

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
}>;

export type WebhookSendResult =
  | Readonly<{
      outcome: "succeeded";
      httpStatus: number;
      latencyMs: number;
    }>
  | Readonly<{
      outcome: "failed";
      errorCode: "HTTP_ERROR" | "NETWORK_ERROR";
      httpStatus?: number;
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

export type WebhookDeliveryWorker = Readonly<{
  process: (
    job: unknown,
    context?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<"processed" | "ignored" | "invalid-job">;
}>;

export function createWebhookDeliveryWorker(options: {
  store: WebhookDeliveryStore;
  sender: WebhookSender;
  clock?: () => string;
  createClaimToken?: () => string;
}): WebhookDeliveryWorker {
  const clock = options.clock ?? (() => new Date().toISOString());
  const createClaimToken = options.createClaimToken ?? randomUUID;

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
      const completed = await options.store.complete({
        deliveryId: delivery.deliveryId,
        claimToken: delivery.claimToken,
        completedAt: clock(),
        result,
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

export function assertWebhookEndpointUrl(
  value: string,
  options: { allowInsecureHttp?: boolean } = {},
): void {
  parseEndpointUrl(value, options.allowInsecureHttp === true);
}

export function createStandardWebhookHttpSender(options: {
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
  clock?: () => string;
  fetchImplementation?: typeof fetch;
} = {}): WebhookSender {
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? 20_000,
    "Webhook request timeout",
  );
  const clock = options.clock ?? (() => new Date().toISOString());
  const send = options.fetchImplementation ?? fetch;

  return Object.freeze({
    send: async (request): Promise<WebhookSendResult> => {
      const url = parseEndpointUrl(request.url, options.allowInsecureHttp === true);
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
        const response = await send(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "webhook-id": request.eventId,
            "webhook-timestamp": timestamp,
            "webhook-signature": signatures.join(" "),
          },
          body: request.payload,
          redirect: "manual",
          signal: request.signal
            ? AbortSignal.any([
                request.signal,
                AbortSignal.timeout(timeoutMs),
              ])
            : AbortSignal.timeout(timeoutMs),
        });
        const latencyMs = elapsedMilliseconds(startedAt);
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
              latencyMs,
            });
      } catch {
        return Object.freeze({
          outcome: "failed",
          errorCode: "NETWORK_ERROR",
          latencyMs: elapsedMilliseconds(startedAt),
        });
      }
    },
  });
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

function parseEndpointUrl(value: string, allowInsecureHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Webhook Endpoint URL is invalid");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:"))
  ) {
    throw new Error("Webhook Endpoint URL is invalid");
  }
  return url;
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
