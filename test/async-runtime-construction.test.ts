import { describe, expect, it } from "vitest";
import {
  constructProcessDispatcherService,
  constructProcessRecoveryCommand,
  constructProcessWorkerService,
  constructRetentionCleanerService,
} from "../src/async-runtime-construction.js";

describe("Async runtime role construction", () => {
  it("requires only role-owned Dispatcher connection configuration", () => {
    expect(() => constructProcessDispatcherService({})).toThrow(
      "DATABASE_URL is required for this runtime role",
    );
    expect(() =>
      constructProcessDispatcherService({ DATABASE_URL: DATABASE_URL }),
    ).toThrow("REDIS_URL is required for this runtime role");
    expect(() =>
      constructProcessDispatcherService({
        DATABASE_URL,
        REDIS_URL,
        PROCESS_QUEUE_PREFIX: "bad prefix",
      }),
    ).toThrow("PROCESS_QUEUE_PREFIX is invalid");
    expect(() =>
      constructProcessDispatcherService({
        DATABASE_URL,
        REDIS_URL,
        OUTBOX_DISPATCH_BATCH_SIZE: "101",
      }),
    ).toThrow("OUTBOX_DISPATCH_BATCH_SIZE must not exceed 100");
  });

  it("requires Worker business, persistence, Redis, and retention configuration", () => {
    expect(() => constructProcessWorkerService({})).toThrow(
      "BUSINESS_API_BASE_URL is required",
    );
    expect(() =>
      constructProcessWorkerService({
        BUSINESS_API_BASE_URL: "https://business.example",
      }),
    ).toThrow("DATABASE_URL is required for this runtime role");
    expect(() =>
      constructProcessWorkerService({
        BUSINESS_API_BASE_URL: "https://business.example",
        DATABASE_URL,
      }),
    ).toThrow("REDIS_URL is required for this runtime role");
    expect(() =>
      constructProcessWorkerService({
        BUSINESS_API_BASE_URL: "https://business.example",
        DATABASE_URL,
        REDIS_URL,
      }),
    ).toThrow(
      "PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS is required for the Process Worker role",
    );
  });

  it("rejects a claim lease that can expire during the Process timeout", () => {
    expect(() =>
      constructProcessWorkerService({
        BUSINESS_API_BASE_URL: "https://business.example",
        DATABASE_URL,
        REDIS_URL,
        PROCESS_TIMEOUT_MS: "60000",
        PROCESS_RUN_CLAIM_LEASE_MS: "60000",
      }),
    ).toThrow(
      "PROCESS_RUN_CLAIM_LEASE_MS must exceed PROCESS_TIMEOUT_MS",
    );
  });

  it("constructs the Retention Cleaner from role-owned PostgreSQL settings", async () => {
    expect(() => constructRetentionCleanerService({})).toThrow(
      "DATABASE_URL is required for this runtime role",
    );
    expect(() =>
      constructRetentionCleanerService({
        DATABASE_URL,
        RETENTION_CLEANUP_BATCH_SIZE: "101",
      }),
    ).toThrow("RETENTION_CLEANUP_BATCH_SIZE must not exceed 100");
    const service = constructRetentionCleanerService({
      DATABASE_URL,
      WEBHOOK_DELIVERY_HISTORY_RETENTION_MS: "2592000000",
    });
    await service.application.close();
  });

  it("constructs one-shot Queue Recovery from Dispatcher-owned settings", async () => {
    expect(() => constructProcessRecoveryCommand({})).toThrow(
      "DATABASE_URL is required for this runtime role",
    );
    expect(() =>
      constructProcessRecoveryCommand({ DATABASE_URL }),
    ).toThrow("REDIS_URL is required for this runtime role");
    const command = constructProcessRecoveryCommand({ DATABASE_URL, REDIS_URL });
    await command.close();
    await command.close();
  });
});

const DATABASE_URL =
  "postgresql://service:local-only@127.0.0.1:55432/pipipi_test";
const REDIS_URL = "redis://127.0.0.1:56379/15";
