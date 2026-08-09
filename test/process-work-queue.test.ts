import { describe, expect, it } from "vitest";
import {
    createInMemoryProcessWorkQueue,
    ProcessWorkQueueCapacityError,
    parseProcessWorkJob,
} from "../src/runs/queue.js";
import { processWorkQueueContract } from "./support/process-work-queue-contract.js";

processWorkQueueContract("in-memory", () =>
    createInMemoryProcessWorkQueue({ maxJobs: 10 }),
);

describe("In-memory Process Work Queue", () => {
    it("requires a positive bound and never evicts pending work", async () => {
        expect(() => createInMemoryProcessWorkQueue({ maxJobs: 0 })).toThrow(
            "Process Work Queue capacity must be a positive integer",
        );
        const queue = createInMemoryProcessWorkQueue({ maxJobs: 1 });
        const first = {
            schemaVersion: 1 as const,
            runId: "00000000-0000-4000-8000-000000000001",
        };
        await queue.enqueue(first);
        await expect(
            queue.enqueue({
                schemaVersion: 1,
                runId: "00000000-0000-4000-8000-000000000002",
            }),
        ).rejects.toBeInstanceOf(ProcessWorkQueueCapacityError);
        await expect(queue.take()).resolves.toEqual(first);
    });

    it("strictly parses the versioned minimal job envelope", () => {
        expect(
            parseProcessWorkJob({
                schemaVersion: 1,
                runId: "00000000-0000-4000-8000-000000000001",
            }),
        ).toEqual({
            schemaVersion: 1,
            runId: "00000000-0000-4000-8000-000000000001",
        });
        expect(
            parseProcessWorkJob({
                schemaVersion: 1,
                runId: "00000000-0000-4000-8000-000000000001",
                input: { secret: true },
            }),
        ).toBeUndefined();
        expect(
            parseProcessWorkJob({ schemaVersion: 2, runId: "run" }),
        ).toBeUndefined();
    });
});
