import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPinnedWebhookHttpClient,
  createWebhookTargetPolicy,
} from "../src/webhooks/target-policy.js";

let server: Server | undefined;

afterEach(async () => {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
});

describe("Webhook target policy", () => {
  it.each([
    ["http://hooks.example/path", "WEBHOOK_TARGET_INSECURE_SCHEME"],
    ["https://user:password@hooks.example/path", "WEBHOOK_TARGET_INVALID_URL"],
    ["https://hooks.example/path#fragment", "WEBHOOK_TARGET_INVALID_URL"],
    ["file:///etc/passwd", "WEBHOOK_TARGET_INSECURE_SCHEME"],
  ])("rejects invalid target %s with stable code %s", async (url, code) => {
    const policy = createWebhookTargetPolicy({
      resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    await expect(policy.resolve(url)).rejects.toMatchObject({ code });
  });

  it.each([
    "127.0.0.1",
    "10.2.3.4",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "2002:7f00:1::",
  ])("rejects forbidden address %s", async (address) => {
    const family = address.includes(":") ? 6 : 4;
    const policy = createWebhookTargetPolicy({
      resolveHostname: async () => [{ address, family } as const],
    });
    await expect(policy.resolve("https://hooks.example/path")).rejects.toMatchObject(
      { code: "WEBHOOK_TARGET_FORBIDDEN_ADDRESS" },
    );
  });

  it("rejects a DNS answer set if any address is unsafe", async () => {
    const policy = createWebhookTargetPolicy({
      resolveHostname: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    await expect(policy.resolve("https://hooks.example/path")).rejects.toMatchObject(
      { code: "WEBHOOK_TARGET_FORBIDDEN_ADDRESS" },
    );
  });

  it.each([
    "https://127.1/hook",
    "https://2130706433/hook",
    "https://0x7f000001/hook",
    "https://[::1]/hook",
    "https://[::ffff:7f00:1]/hook",
  ])("normalizes and rejects direct-address target %s", async (url) => {
    const policy = createWebhookTargetPolicy();
    await expect(policy.resolve(url)).rejects.toMatchObject({
      code: "WEBHOOK_TARGET_FORBIDDEN_ADDRESS",
    });
  });

  it("pins the validated address and never follows a redirect", async () => {
    let requestCount = 0;
    server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      response.end();
    });
    const port = await listen(server);
    const resolveHostname = vi.fn(async () => [
      { address: "127.0.0.1", family: 4 as const },
    ]);
    const client = createPinnedWebhookHttpClient({
      targetPolicy: createWebhookTargetPolicy({
        allowInsecureHttp: true,
        allowUnsafeAddresses: true,
        resolveHostname,
      }),
    });

    await expect(
      client.post({
        url: `http://public.example:${port}/redirect`,
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(1_000),
      }),
    ).resolves.toEqual({ status: 302, retryAfter: null });
    expect(resolveHostname).toHaveBeenCalledOnce();
    expect(requestCount).toBe(1);
  });
});

async function listen(target: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      target.off("error", reject);
      resolve();
    });
  });
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("Expected address");
  return address.port;
}
