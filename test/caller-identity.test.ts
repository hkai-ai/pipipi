import { describe, expect, it } from "vitest";
import {
    callerIdentityHeader,
    createGatewayCallerIdentityResolver,
    gatewayAuthenticationHeader,
} from "../src/api/identity.js";

describe("Gateway Caller Identity", () => {
    const sharedSecret = "gateway-test-secret-that-is-at-least-32-bytes";

    it("accepts only a caller identity authenticated by the gateway secret", async () => {
        const resolver = createGatewayCallerIdentityResolver({ sharedSecret });

        await expect(
            resolver.resolve({
                [callerIdentityHeader]: "  service:catalog  ",
                [gatewayAuthenticationHeader]: sharedSecret,
            }),
        ).resolves.toEqual({ callerId: "service:catalog" });
        await expect(
            resolver.resolve({
                [callerIdentityHeader]: "service:catalog",
                [gatewayAuthenticationHeader]: "wrong-secret",
            }),
        ).resolves.toBeUndefined();
        await expect(
            resolver.resolve({ [callerIdentityHeader]: "service:catalog" }),
        ).resolves.toBeUndefined();
        await expect(
            resolver.resolve({
                [callerIdentityHeader]: ["service:a", "service:b"],
                [gatewayAuthenticationHeader]: sharedSecret,
            }),
        ).resolves.toBeUndefined();
    });

    it("requires a deployment secret with a meaningful minimum size", () => {
        expect(() =>
            createGatewayCallerIdentityResolver({ sharedSecret: "too-short" }),
        ).toThrow("ASYNC_GATEWAY_SHARED_SECRET must be at least 32 bytes");
    });
});

describe("API Key Caller Identity", () => {
    it("does not await or propagate last-use observation failures", async () => {
        const { createInMemoryCallerApiKeyStore } = await import(
            "../src/caller-api-keys/memory.js"
        );
        const { createApiKeyCallerIdentityResolver } = await import(
            "../src/api/identity.js"
        );
        const store = createInMemoryCallerApiKeyStore();
        const issued = await store.issue({ callerId: "caller", label: "test" });
        for (const recordUse of [
            () => new Promise<void>(() => {}),
            async () => {
                throw new Error("private error");
            },
            () => {
                throw new Error("private sync error");
            },
        ]) {
            const resolver = createApiKeyCallerIdentityResolver({
                ...store,
                recordUse,
            });
            await expect(
                resolver.resolve({ authorization: `Bearer ${issued.key}` }),
            ).resolves.toEqual({ callerId: "caller", authMethod: "api_key" });
        }
    });
    it("rejects malformed Pipipi Bearer credentials without trusting injected headers", async () => {
        const { createInMemoryCallerApiKeyStore } = await import(
            "../src/caller-api-keys/memory.js"
        );
        const { createCompositeCallerIdentityResolver } = await import(
            "../src/api/identity.js"
        );
        const resolver = createCompositeCallerIdentityResolver({
            store: createInMemoryCallerApiKeyStore(),
            gateway: { resolve: async () => ({ callerId: "forged" }) },
        });
        for (const authorization of [
            "Bearer ppk_invalid extra",
            "Bearer ppk_invalid",
            "Bearer PPK_invalid",
        ])
            await expect(
                resolver.resolve({ authorization }),
            ).resolves.toBeUndefined();
    });
});
