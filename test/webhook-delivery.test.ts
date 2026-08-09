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

  it("parses Retry-After without reading or persisting the remote response body", async () => {
    const sender = createStandardWebhookHttpSender({
      clock: () => "2026-08-09T10:00:00.000Z",
      fetchImplementation: async () =>
        new Response("remote details must remain unread", {
          status: 429,
          headers: { "retry-after": "10" },
        }),
    });

    await expect(
      sender.send({
        url: "https://hooks.example/process-runs",
        eventId: "event-1",
        payload: '{"eventId":"event-1"}',
        secrets: [signingSecret],
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      errorCode: "HTTP_ERROR",
      httpStatus: 429,
      retryAfterMs: 10_000,
    });
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
        createdAt: "2026-08-09T10:00:00.000Z",
      })),
      complete,
      reschedule: vi.fn(async () => true),
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

  it("retries only network, 429, and 5xx failures with bounded backoff", async () => {
    const reschedule = vi.fn<WebhookDeliveryStore["reschedule"]>(async () => true);
    const complete = vi.fn<WebhookDeliveryStore["complete"]>(async () => true);
    const store = deliveryStore({ reschedule, complete, attemptNumber: 1 });
    const worker = createWebhookDeliveryWorker({
      store,
      sender: {
        send: async () => ({
          outcome: "failed",
          errorCode: "HTTP_ERROR",
          httpStatus: 503,
          retryAfterMs: 10_000,
          latencyMs: 7,
        }),
      },
      retryPolicy: {
        maximumAttempts: 3,
        initialBackoffMs: 1_000,
        maximumBackoffMs: 8_000,
        maximumRetryAfterMs: 5_000,
        deliveryHorizonMs: 60_000,
        jitterPercent: 0,
      },
      clock: sequenceClock([
        "2026-08-09T10:00:00.000Z",
        "2026-08-09T10:00:01.000Z",
      ]),
      createClaimToken: () => "claim-1",
    });

    await expect(
      worker.process({ schemaVersion: 1, deliveryId: "delivery-1" }),
    ).resolves.toEqual({ outcome: "retry-scheduled", delayMs: 5_000 });
    expect(reschedule).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      claimToken: "claim-1",
      completedAt: "2026-08-09T10:00:01.000Z",
      nextAttemptAt: "2026-08-09T10:00:06.000Z",
      result: {
        outcome: "failed",
        errorCode: "HTTP_ERROR",
        httpStatus: 503,
        retryAfterMs: 10_000,
        latencyMs: 7,
      },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not retry permanent 4xx and disables only an Endpoint returning 410", async () => {
    for (const httpStatus of [400, 410]) {
      const complete = vi.fn<WebhookDeliveryStore["complete"]>(async () => true);
      const reschedule = vi.fn<WebhookDeliveryStore["reschedule"]>(async () => true);
      const worker = createWebhookDeliveryWorker({
        store: deliveryStore({ complete, reschedule, attemptNumber: 1 }),
        sender: {
          send: async () => ({
            outcome: "failed",
            errorCode: "HTTP_ERROR",
            httpStatus,
            latencyMs: 4,
          }),
        },
        clock: sequenceClock([
          "2026-08-09T10:00:00.000Z",
          "2026-08-09T10:00:01.000Z",
        ]),
        createClaimToken: () => "claim-1",
      });

      await expect(
        worker.process({ schemaVersion: 1, deliveryId: "delivery-1" }),
      ).resolves.toBe("processed");
      expect(reschedule).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledWith({
        deliveryId: "delivery-1",
        claimToken: "claim-1",
        completedAt: "2026-08-09T10:00:01.000Z",
        result: {
          outcome: "failed",
          errorCode: "HTTP_ERROR",
          httpStatus,
          latencyMs: 4,
        },
        terminalStatus: "failed",
        disableEndpoint: httpStatus === 410,
      });
    }
  });

  it("marks a retryable failure exhausted at the configured Attempt limit", async () => {
    const complete = vi.fn<WebhookDeliveryStore["complete"]>(async () => true);
    const reschedule = vi.fn<WebhookDeliveryStore["reschedule"]>(async () => true);
    const worker = createWebhookDeliveryWorker({
      store: deliveryStore({ complete, reschedule, attemptNumber: 3 }),
      sender: {
        send: async () => ({
          outcome: "failed",
          errorCode: "NETWORK_ERROR",
          latencyMs: 3,
        }),
      },
      retryPolicy: {
        maximumAttempts: 3,
        initialBackoffMs: 1_000,
        maximumBackoffMs: 8_000,
        maximumRetryAfterMs: 5_000,
        deliveryHorizonMs: 60_000,
        jitterPercent: 0,
      },
      clock: sequenceClock([
        "2026-08-09T10:00:00.000Z",
        "2026-08-09T10:00:01.000Z",
      ]),
      createClaimToken: () => "claim-1",
    });

    await expect(
      worker.process({ schemaVersion: 1, deliveryId: "delivery-1" }),
    ).resolves.toBe("processed");
    expect(reschedule).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ terminalStatus: "exhausted" }),
    );
  });
});

function deliveryStore(options: {
  complete: WebhookDeliveryStore["complete"];
  reschedule: WebhookDeliveryStore["reschedule"];
  attemptNumber: number;
}): WebhookDeliveryStore {
  return {
    claim: async () => ({
      deliveryId: "delivery-1",
      eventId: "event-1",
      endpointId: "endpoint-1",
      endpointUrl: "https://hooks.example/process-runs",
      secrets: [signingSecret],
      payload: '{"eventId":"event-1"}',
      claimToken: "claim-1",
      attemptNumber: options.attemptNumber,
      createdAt: "2026-08-09T10:00:00.000Z",
    }),
    complete: options.complete,
    reschedule: options.reschedule,
  };
}

function sequenceClock(values: readonly string[]): () => string {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (!value) throw new Error("Clock exhausted");
    return value;
  };
}

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
