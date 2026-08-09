import { describe, expect, it } from "vitest";
import { constructWebhookWorkerService } from "../src/webhook-runtime-construction.js";

describe("Webhook Worker construction", () => {
  it("requires only role-owned PostgreSQL and Redis configuration", () => {
    expect(() => constructWebhookWorkerService({})).toThrow(
      "DATABASE_URL is required for the Webhook Worker role",
    );
    expect(() =>
      constructWebhookWorkerService({ DATABASE_URL }),
    ).toThrow("REDIS_URL is required for the Webhook Worker role");
    expect(() =>
      constructWebhookWorkerService({
        DATABASE_URL,
        REDIS_URL,
        WEBHOOK_QUEUE_PREFIX: "bad prefix",
      }),
    ).toThrow("WEBHOOK_QUEUE_PREFIX is invalid");
  });

  it("bounds network and lease configuration before opening connections", () => {
    expect(() =>
      constructWebhookWorkerService({
        DATABASE_URL,
        REDIS_URL,
        WEBHOOK_REQUEST_TIMEOUT_MS: "30000",
        WEBHOOK_DELIVERY_CLAIM_LEASE_MS: "30000",
      }),
    ).toThrow(
      "WEBHOOK_DELIVERY_CLAIM_LEASE_MS must exceed WEBHOOK_REQUEST_TIMEOUT_MS",
    );
    expect(() =>
      constructWebhookWorkerService({
        DATABASE_URL,
        REDIS_URL,
        WEBHOOK_ALLOW_INSECURE_HTTP: "yes",
      }),
    ).toThrow("WEBHOOK_ALLOW_INSECURE_HTTP must be true or false");
    expect(() =>
      constructWebhookWorkerService({
        DATABASE_URL,
        REDIS_URL,
        WEBHOOK_DELIVERY_MAX_ATTEMPTS: "21",
      }),
    ).toThrow("WEBHOOK_DELIVERY_MAX_ATTEMPTS must not exceed 20");
    expect(() =>
      constructWebhookWorkerService({
        DATABASE_URL,
        REDIS_URL,
        WEBHOOK_DELIVERY_JITTER_PERCENT: "101",
      }),
    ).toThrow("WEBHOOK_DELIVERY_JITTER_PERCENT must be an integer between 0 and 100");
  });
});

const DATABASE_URL =
  "postgresql://service:local-only@127.0.0.1:55432/pipipi_test";
const REDIS_URL = "redis://127.0.0.1:56379/15";
