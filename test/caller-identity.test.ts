import { describe, expect, it } from "vitest";
import {
  callerIdentityHeader,
  createGatewayCallerIdentityResolver,
  gatewayAuthenticationHeader,
} from "../src/caller-identity.js";

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
