import { describe, expect, it, vi } from "vitest";
import { createOutboxDispatcher } from "../src/outbox-dispatcher.js";
import type { ProcessOutbox } from "../src/process-outbox.js";
import type { ProcessWorkQueue } from "../src/process-work-queue.js";

describe("Outbox Dispatcher", () => {
  it("publishes a claimed Process Work message before acknowledging it", async () => {
    const calls: string[] = [];
    const logs: unknown[] = [];
    const outbox = fakeOutbox({
      claimProcessWork: async (request) => {
        calls.push(`claim:${request.claimToken}:${request.claimExpiresAt}`);
        return [
          {
            messageId: "message-1",
            eventId: "event-1",
            claimToken: request.claimToken,
            job: { schemaVersion: 1, runId: runId(1) },
          },
        ];
      },
      markPublished: async (request) => {
        calls.push(`ack:${request.messageId}:${request.publishedAt}`);
        return true;
      },
    });
    const queue = fakeQueue({
      enqueue: async (job) => {
        calls.push(`enqueue:${job.runId}`);
        return "enqueued";
      },
    });
    const timestamps = [
      "2026-08-09T01:00:00.000Z",
      "2026-08-09T01:00:01.000Z",
    ];
    const dispatcher = createOutboxDispatcher({
      outbox,
      queue,
      batchSize: 10,
      claimLeaseMs: 30_000,
      clock: () => timestamps.shift() ?? "unexpected",
      createClaimToken: () => "claim-1",
      logSink: (record) => logs.push(record),
    });

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
    });
    expect(calls).toEqual([
      "claim:claim-1:2026-08-09T01:00:30.000Z",
      `enqueue:${runId(1)}`,
      "ack:message-1:2026-08-09T01:00:01.000Z",
    ]);
    expect(logs).toContainEqual({
      event: "outbox_message_published",
      topic: "process-runs",
      timestamp: "2026-08-09T01:00:01.000Z",
      messageId: "message-1",
      eventId: "event-1",
      runId: runId(1),
    });
  });

  it("releases a claim when publishing fails so a later pass can retry", async () => {
    const logs: unknown[] = [];
    const release = vi.fn(async () => true);
    const outbox = fakeOutbox({
      claimProcessWork: async (request) => [
        {
          messageId: "message-2",
          eventId: "event-2",
          claimToken: request.claimToken,
          job: { schemaVersion: 1, runId: runId(2) },
        },
      ],
      release,
    });
    const dispatcher = createOutboxDispatcher({
      outbox,
      queue: fakeQueue({
        enqueue: async () => {
          throw new Error("Redis unavailable");
        },
      }),
      clock: () => "2026-08-09T01:00:00.000Z",
      createClaimToken: () => "claim-2",
      logSink: (record) => logs.push(record),
    });

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 1,
      published: 0,
      failed: 1,
    });
    expect(release).toHaveBeenCalledWith({
      messageId: "message-2",
      claimToken: "claim-2",
    });
    expect(logs).toContainEqual({
      event: "outbox_message_publish_failed",
      topic: "process-runs",
      timestamp: "2026-08-09T01:00:00.000Z",
      messageId: "message-2",
      eventId: "event-2",
      runId: runId(2),
    });
    expect(JSON.stringify(logs)).not.toContain("Redis unavailable");
  });

  it("isolates one failed message and continues the claimed batch", async () => {
    const outbox = fakeOutbox({
      claimProcessWork: async (request) => [1, 2].map((index) => ({
        messageId: `message-${index}`,
        eventId: `event-${index}`,
        claimToken: request.claimToken,
        job: { schemaVersion: 1 as const, runId: runId(index) },
      })),
    });
    const dispatcher = createOutboxDispatcher({
      outbox,
      queue: fakeQueue({
        enqueue: async (job) => {
          if (job.runId === runId(1)) throw new Error("temporary failure");
          return "enqueued";
        },
      }),
      clock: () => "2026-08-09T01:00:00.000Z",
      createClaimToken: () => "claim-batch",
    });

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 2,
      published: 1,
      failed: 1,
    });
  });

  it("rejects unsafe dispatcher bounds before claiming work", () => {
    const outbox = fakeOutbox();
    const queue = fakeQueue();

    expect(() =>
      createOutboxDispatcher({ outbox, queue, batchSize: 101 }),
    ).toThrow("Outbox batch size must not exceed 100");
    expect(() =>
      createOutboxDispatcher({ outbox, queue, claimLeaseMs: 0 }),
    ).toThrow("Outbox claim lease must be a positive safe integer");
  });
});

function fakeOutbox(
  overrides: Partial<ProcessOutbox> = {},
): ProcessOutbox {
  return {
    claimProcessWork: async () => [],
    markPublished: async () => true,
    release: async () => true,
    ...overrides,
  };
}

function fakeQueue(
  overrides: Partial<ProcessWorkQueue> = {},
): ProcessWorkQueue {
  return {
    enqueue: async () => "enqueued",
    close: async () => undefined,
    ...overrides,
  };
}

function runId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
