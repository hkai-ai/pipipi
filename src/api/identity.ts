/** 通过唯一身份接缝解析调用方 API Key，并受控兼容网关注入身份。 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
    type CallerApiKeyStore,
    callerApiKeyPrefix,
} from "../caller-api-keys/index.js";

export const callerIdentityHeader = "x-pipipi-caller-id";
export const gatewayAuthenticationHeader = "x-pipipi-gateway-token";

export type CallerIdentity = Readonly<{
    callerId: string;
    authMethod?: "api_key" | "gateway";
}>;

export type CallerIdentityResolver = Readonly<{
    resolve: (
        headers: IncomingHttpHeaders,
    ) => Promise<CallerIdentity | undefined>;
}>;

export function createGatewayCallerIdentityResolver(options: {
    sharedSecret: string;
    secretName?: string;
}): CallerIdentityResolver {
    if (Buffer.byteLength(options.sharedSecret, "utf8") < 32) {
        throw new Error(
            `${options.secretName ?? "ASYNC_GATEWAY_SHARED_SECRET"} must be at least 32 bytes`,
        );
    }
    const expectedSecretDigest = digest(options.sharedSecret);

    return Object.freeze({
        resolve: async (headers) => {
            const suppliedSecret = singleHeader(
                headers[gatewayAuthenticationHeader],
            );
            const callerId = singleHeader(
                headers[callerIdentityHeader],
            )?.trim();
            if (
                suppliedSecret === undefined ||
                callerId === undefined ||
                callerId.length === 0 ||
                Buffer.byteLength(callerId, "utf8") > 512 ||
                !timingSafeEqual(digest(suppliedSecret), expectedSecretDigest)
            ) {
                return undefined;
            }
            return Object.freeze({ callerId });
        },
    });
}

function singleHeader(
    value: string | string[] | undefined,
): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function digest(value: string): Buffer {
    return createHash("sha256").update(value, "utf8").digest();
}

export function createApiKeyCallerIdentityResolver(
    store: CallerApiKeyStore,
): CallerIdentityResolver {
    return {
        resolve: async (headers) => {
            const token = bearer(headers);
            if (!token?.startsWith(callerApiKeyPrefix)) return undefined;
            const key = await store.findValid(token);
            if (!key) return undefined;
            // 不等待使用观测写库；同步抛错与异步拒绝都不能影响已认证请求。
            void Promise.resolve()
                .then(() => store.recordUse(key.keyId))
                .catch(() => {});
            return { callerId: key.callerId, authMethod: "api_key" };
        },
    };
}
export function createCompositeCallerIdentityResolver(options: {
    store: CallerApiKeyStore;
    gateway?: CallerIdentityResolver;
}): CallerIdentityResolver {
    const apiKey = createApiKeyCallerIdentityResolver(options.store);
    return {
        resolve: async (headers) => {
            if (
                /^Bearer[ \t]+ppk_/i.test(
                    singleHeader(headers.authorization) ?? "",
                )
            )
                return apiKey.resolve(headers);
            const caller = await options.gateway?.resolve(headers);
            return caller ? { ...caller, authMethod: "gateway" } : undefined;
        },
    };
}
function bearer(headers: IncomingHttpHeaders): string | undefined {
    const value = singleHeader(headers.authorization);
    return value
        ? /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(value)?.[1]
        : undefined;
}
