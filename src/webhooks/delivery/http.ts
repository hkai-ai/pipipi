/** 用 Standard Webhooks 签名和目标策略发起签名 HTTP 投递，产出成功/失败结果 */
import { signStandardWebhook } from "./signing.js";
import {
    createPinnedWebhookHttpClient,
    createWebhookTargetPolicy,
    isWebhookTargetPolicyError,
    type WebhookHttpClient,
    type WebhookTargetPolicy,
    type WebhookTargetRejectionCode,
} from "./target-policy.js";

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

export type WebhookSender = Readonly<{
    send: (request: {
        url: string;
        eventId: string;
        payload: string;
        secrets: readonly string[];
        signal?: AbortSignal;
    }) => Promise<WebhookSendResult>;
}>;

export function createStandardWebhookHttpSender(
    options: {
        timeoutMs?: number;
        clock?: () => string;
        targetPolicy?: WebhookTargetPolicy;
        httpClient?: WebhookHttpClient;
    } = {},
): WebhookSender {
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
                throw new Error(
                    "Webhook Delivery requires one or two signing secrets",
                );
            }
            if (Buffer.byteLength(request.payload, "utf8") > 20_480) {
                throw new Error(
                    "Webhook payload must not exceed 20480 UTF-8 bytes",
                );
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

function timestampMilliseconds(timestamp: string): number {
    const value = new Date(timestamp).getTime();
    if (!Number.isFinite(value))
        throw new Error("Webhook timestamp is invalid");
    return value;
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
