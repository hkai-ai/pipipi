import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const callerIdentityHeader = "x-pipipi-caller-id";
export const gatewayAuthenticationHeader = "x-pipipi-gateway-token";

export type CallerIdentity = Readonly<{ callerId: string }>;

export type CallerIdentityResolver = Readonly<{
    resolve: (
        headers: IncomingHttpHeaders,
    ) => Promise<CallerIdentity | undefined>;
}>;

export function createGatewayCallerIdentityResolver(options: {
    sharedSecret: string;
}): CallerIdentityResolver {
    if (Buffer.byteLength(options.sharedSecret, "utf8") < 32) {
        throw new Error(
            "ASYNC_GATEWAY_SHARED_SECRET must be at least 32 bytes",
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
