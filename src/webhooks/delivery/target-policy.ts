/** 基于公网 HTTP 目标策略解析并 Pin 住 Webhook 投递目标地址，拒绝内网/不安全目标 */
import {
    createPinnedPublicHttpTransport,
    createPublicHttpTargetPolicy,
    isPublicHttpTargetPolicyError,
    type PublicHttpTargetRejectionCode,
    type ResolvedPublicAddress,
    type ResolvedPublicHttpTarget,
} from "../../network/public-http.js";

export type WebhookTargetRejectionCode =
    | "WEBHOOK_TARGET_INVALID_URL"
    | "WEBHOOK_TARGET_INSECURE_SCHEME"
    | "WEBHOOK_TARGET_FORBIDDEN_ADDRESS"
    | "WEBHOOK_TARGET_DNS_FAILED";

export class WebhookTargetPolicyError extends Error {
    readonly code: WebhookTargetRejectionCode;

    constructor(code: WebhookTargetRejectionCode) {
        super(code);
        this.name = "WebhookTargetPolicyError";
        this.code = code;
    }
}

export type ResolvedWebhookTarget = ResolvedPublicHttpTarget;

export type WebhookTargetPolicy = Readonly<{
    resolve: (url: string) => Promise<ResolvedWebhookTarget>;
}>;

export type WebhookHttpClient = Readonly<{
    post: (request: {
        url: string;
        headers: Readonly<Record<string, string>>;
        body: string;
        signal: AbortSignal;
    }) => Promise<Readonly<{ status: number; retryAfter: string | null }>>;
}>;

export function createWebhookTargetPolicy(
    options: {
        allowInsecureHttp?: boolean;
        allowUnsafeAddresses?: boolean;
        resolveHostname?: (
            hostname: string,
        ) => Promise<readonly ResolvedPublicAddress[]>;
    } = {},
): WebhookTargetPolicy {
    const policy = createPublicHttpTargetPolicy(options);
    return Object.freeze({
        resolve: async (url) => {
            try {
                return await policy.resolve(url);
            } catch (error) {
                if (!isPublicHttpTargetPolicyError(error)) throw error;
                throw new WebhookTargetPolicyError(
                    webhookRejectionCode(error.code),
                );
            }
        },
    });
}

export function createPinnedWebhookHttpClient(options: {
    targetPolicy: WebhookTargetPolicy;
}): WebhookHttpClient {
    const transport = createPinnedPublicHttpTransport({
        targetPolicy: options.targetPolicy,
    });
    return Object.freeze({
        post: async (request) => {
            const response = await transport.request({
                ...request,
                method: "POST",
                maxResponseBytes: 0,
            });
            return Object.freeze({
                status: response.status,
                retryAfter: response.retryAfter,
            });
        },
    });
}

export function isWebhookTargetPolicyError(
    error: unknown,
): error is WebhookTargetPolicyError {
    return error instanceof WebhookTargetPolicyError;
}

function webhookRejectionCode(
    code: PublicHttpTargetRejectionCode,
): WebhookTargetRejectionCode {
    const suffix = code.slice("PUBLIC_HTTP_".length);
    return `WEBHOOK_${suffix}` as WebhookTargetRejectionCode;
}
