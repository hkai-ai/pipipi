import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStandardWebhookHttpSender,
  createWebhookDeliveryWorker,
  signStandardWebhook,
  type WebhookDeliveryStore,
} from "../src/webhook-delivery.js";

const signingKey = Buffer.alloc(32, 7);
const signingSecret = `whsec_${signingKey.toString("base64")}`;

let server: Server | undefined;

afterEach(async () => {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
});

describe("Webhook Delivery", () => {
  it("signs the exact raw body and Standard Webhooks metadata", () => {
    const payload = '{"type":"process_run.succeeded","data":{"runId":"run-1"}}';
    const messageId = "event-1";
    const timestamp = "1786255200";
    const expected = createHmac("sha256", signingKey)
      .update(`${messageId}.${timestamp}.${payload}`)
      .digest("base64");

    expect(
      signStandardWebhook({
        messageId,
        timestamp,
        payload,
        secret: signingSecret,
      }),
    ).toBe(`v1,${expected}`);
    expect(() =>
      signStandardWebhook({
        messageId,
        timestamp,
        payload,
        secret: "plain-text-secret",
      }),
    ).toThrow("Webhook secret must use whsec_ base64 encoding");
  });

  it("posts a thin payload with verifiable headers and treats any 2xx as success", async () => {
    const received: Array<{
      body: string;
      headers: Record<string, string | string[] | undefined>;
    }> = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({ body: Buffer.concat(chunks).toString("utf8"), headers: request.headers });
      response.writeHead(204).end();
    });
    const url = await listen(server);
    const sender = createStandardWebhookHttpSender({
      allowInsecureHttp: true,
      timeoutMs: 1_000,
      clock: () => "2026-08-09T10:00:00.000Z",
    });
    const payload =
      '{"schemaVersion":1,"eventId":"event-1","type":"process_run.succeeded","createdAt":"2026-08-09T09:59:59.000Z","data":{"runId":"run-1","process":"content-processing","version":"v1","status":"succeeded","resultLocation":"/process-runs/run-1"}}';

    await expect(
      sender.send({
        url,
        eventId: "event-1",
        payload,
        secrets: [signingSecret],
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", httpStatus: 204 });
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe(payload);
    expect(received[0]?.headers["webhook-id"]).toBe("event-1");
    expect(received[0]?.headers["webhook-timestamp"]).toBe("1786269600");
    expect(received[0]?.headers["webhook-signature"]).toBe(
      signStandardWebhook({
        messageId: "event-1",
        timestamp: "1786269600",
        payload,
        secret: signingSecret,
      }),
    );
    expect(payload).not.toContain("input");
    expect(payload).not.toContain("output");
  });

  it("claims, sends, and persists a successful Delivery without exposing transport to the Process", async () => {
    const complete = vi.fn<WebhookDeliveryStore["complete"]>(async () => true);
    const store: WebhookDeliveryStore = {
      claim: vi.fn(async () => ({
        deliveryId: "delivery-1",
        eventId: "event-1",
        endpointId: "endpoint-1",
        endpointUrl: "https://hooks.example/process-runs",
        secrets: [signingSecret],
        payload: '{"eventId":"event-1"}',
        claimToken: "claim-1",
        attemptNumber: 1,
      })),
      complete,
    };
    const send = vi.fn(async () => ({
      outcome: "succeeded" as const,
      httpStatus: 202,
      latencyMs: 12,
    }));
    const worker = createWebhookDeliveryWorker({
      store,
      sender: { send },
      clock: () => "2026-08-09T10:00:00.000Z",
      createClaimToken: () => "claim-1",
    });

    await expect(
      worker.process({ schemaVersion: 1, deliveryId: "delivery-1" }),
    ).resolves.toBe("processed");
    expect(send).toHaveBeenCalledWith({
      url: "https://hooks.example/process-runs",
      eventId: "event-1",
      payload: '{"eventId":"event-1"}',
      secrets: [signingSecret],
    });
    expect(complete).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      claimToken: "claim-1",
      completedAt: "2026-08-09T10:00:00.000Z",
      result: { outcome: "succeeded", httpStatus: 202, latencyMs: 12 },
    });
  });
});

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      target.off("error", reject);
      resolve();
    });
  });
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("Expected address");
  return `http://127.0.0.1:${address.port}`;
}
