import { randomUUID } from "node:crypto";
import type { ProcessOutbox } from "./process-outbox.js";
import type { ProcessWorkQueue } from "./process-work-queue.js";

export type OutboxDispatchResult = Readonly<{
  claimed: number;
  published: number;
  failed: number;
}>;

export type OutboxDispatcher = Readonly<{
  dispatchOnce: () => Promise<OutboxDispatchResult>;
}>;

export function createOutboxDispatcher(options: {
  outbox: ProcessOutbox;
  queue: ProcessWorkQueue;
  batchSize?: number;
  claimLeaseMs?: number;
  clock?: () => string;
  createClaimToken?: () => string;
}): OutboxDispatcher {
  const batchSize = positiveInteger(options.batchSize ?? 25, "Outbox batch size");
  if (batchSize > 100) {
    throw new Error("Outbox batch size must not exceed 100");
  }
  const claimLeaseMs = positiveInteger(
    options.claimLeaseMs ?? 30_000,
    "Outbox claim lease",
  );
  const clock = options.clock ?? (() => new Date().toISOString());
  const createClaimToken = options.createClaimToken ?? randomUUID;

  return Object.freeze({
    dispatchOnce: async () => {
      const claimedAt = clock();
      const messages = await options.outbox.claimProcessWork({
        limit: batchSize,
        claimToken: createClaimToken(),
        claimedAt,
        claimExpiresAt: addMilliseconds(claimedAt, claimLeaseMs),
      });
      let published = 0;
      let failed = 0;
      for (const message of messages) {
        try {
          await options.queue.enqueue(message.job);
          const marked = await options.outbox.markPublished({
            messageId: message.messageId,
            claimToken: message.claimToken,
            publishedAt: clock(),
          });
          if (!marked) throw new Error("Outbox publish claim was lost");
          published += 1;
        } catch {
          failed += 1;
          await options.outbox.release({
            messageId: message.messageId,
            claimToken: message.claimToken,
          });
        }
      }
      return Object.freeze({
        claimed: messages.length,
        published,
        failed,
      });
    },
  });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function addMilliseconds(timestamp: string, durationMs: number): string {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) throw new Error("Outbox timestamp is invalid");
  return new Date(time + durationMs).toISOString();
}
