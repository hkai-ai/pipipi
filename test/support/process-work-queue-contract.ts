import { describe, expect, it } from "vitest";
import type {
  ProcessWorkQueue,
  ProcessWorkSource,
} from "../../src/process-work-queue.js";

export function processWorkQueueContract(
  adapterName: string,
  createQueue: () => ProcessWorkQueue & ProcessWorkSource,
): void {
  describe(`${adapterName} Process Work Queue contract`, () => {
    it("publishes the minimal job and returns a defensive copy", async () => {
      const queue = createQueue();
      const job = { schemaVersion: 1 as const, runId: runId(1) };

      await expect(queue.enqueue(job)).resolves.toBe("enqueued");
      const received = await queue.take();
      expect(received).toEqual(job);
      if (!received) throw new Error("Expected Process Work Job");
      (received as { runId: string }).runId = "mutated";
      await expect(queue.take()).resolves.toBeUndefined();
    });

    it("deduplicates a pending runId but allows a later delivery", async () => {
      const queue = createQueue();
      const job = { schemaVersion: 1 as const, runId: runId(2) };

      await expect(queue.enqueue(job)).resolves.toBe("enqueued");
      await expect(queue.enqueue(job)).resolves.toBe("duplicate");
      await expect(queue.take()).resolves.toEqual(job);
      await expect(queue.take()).resolves.toBeUndefined();
      await expect(queue.enqueue(job)).resolves.toBe("enqueued");
      await expect(queue.take()).resolves.toEqual(job);
    });

    it("stops accepting jobs after close", async () => {
      const queue = createQueue();
      await queue.close();
      await queue.close();
      await expect(
        queue.enqueue({ schemaVersion: 1, runId: runId(3) }),
      ).rejects.toThrow("Process Work Queue is closed");
    });
  });
}

function runId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
