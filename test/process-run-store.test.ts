import { describe, expect, it } from "vitest";
import {
  createInMemoryProcessRunStore,
  ProcessRunStoreCapacityError,
} from "../src/process-run-store.js";
import { processRunStoreContract } from "./support/process-run-store-contract.js";

processRunStoreContract("in-memory", () =>
  createInMemoryProcessRunStore({ maxRuns: 10 }),
);

describe("In-memory Process Run Store", () => {
  it("requires a positive bound and refuses to evict durable runs", async () => {
    expect(() => createInMemoryProcessRunStore({ maxRuns: 0 })).toThrow(
      "Process Run Store capacity must be a positive integer",
    );
    const store = createInMemoryProcessRunStore({ maxRuns: 1 });
    const base = {
      ownerId: "caller-a",
      idempotencyKey: "key-a",
      requestFingerprint: "request-a",
      process: "test-processing",
      version: "v1",
      acceptedInput: {
        schemaVersion: 1 as const,
        process: "test-processing",
        version: "v1",
        input: { value: "request" },
      },
      createdAt: "2026-08-09T10:00:00.000Z",
    };
    await store.accept({
      ...base,
      runId: "00000000-0000-4000-8000-000000000001",
    });

    await expect(
      store.accept({
        ...base,
        runId: "00000000-0000-4000-8000-000000000002",
        idempotencyKey: "key-b",
      }),
    ).rejects.toBeInstanceOf(ProcessRunStoreCapacityError);
    await expect(
      store.findOwned(
        "00000000-0000-4000-8000-000000000001",
        "caller-a",
      ),
    ).resolves.toBeDefined();
  });
});
