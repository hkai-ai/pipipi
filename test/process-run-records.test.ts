import { afterEach, describe, expect, it } from "vitest";
import {
    createProcessingApplication,
    type ProcessingApplication,
} from "../src/api/application.js";
import { createBusinessProcessExecutor } from "../src/processes/catalog.js";
import type { ProcessRunResult } from "../src/processes/runtime/index.js";
import {
    createInMemoryProcessRunRecords,
    createProcessRunRecords,
    type ProcessRunRecordAdapter,
    type ProcessRunRecords,
} from "../src/processes/runtime/records.js";

const runningApplications: ProcessingApplication[] = [];

afterEach(async () => {
    await Promise.all(
        runningApplications.splice(0).map((application) => application.close()),
    );
});

describe("Process Run Records", () => {
    it("records safe metadata without business content by default", async () => {
        const records = createInMemoryProcessRunRecords({
            clock: () => "2026-08-08T01:00:00.000Z",
        });
        const result = succeededRun("00000000-0000-4000-8000-000000000001");

        records.record({
            result,
            acceptedRequest: { input: { content: "sensitive input" } },
        });

        expect(await records.find(result.runId)).toEqual({
            schemaVersion: 1,
            recordedAt: "2026-08-08T01:00:00.000Z",
            runId: result.runId,
            process: "content-processing",
            version: "v1",
            status: "succeeded",
        });
    });

    it("can explicitly retain accepted input and validated output", async () => {
        const records = createInMemoryProcessRunRecords({
            content: "accepted-input-and-output",
            clock: () => "2026-08-08T01:00:00.000Z",
        });
        const application = await startApplication(records);

        const response = await fetch(`${application.url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                process: "content-processing",
                version: "v1",
                input: { content: "launch offer" },
            }),
        });
        const result = (await response.json()) as ProcessRunResult;

        expect(response.status).toBe(200);
        expect(await records.find(result.runId)).toEqual({
            schemaVersion: 1,
            recordedAt: "2026-08-08T01:00:00.000Z",
            runId: result.runId,
            process: "content-processing",
            version: "v1",
            status: "succeeded",
            content: {
                input: { content: "launch offer" },
                output: { content: "Processed: launch offer" },
            },
        });
    });

    it("never retains an input rejected by a Process Registration", async () => {
        const records = createInMemoryProcessRunRecords({
            content: "accepted-input-and-output",
            clock: () => "2026-08-08T01:00:00.000Z",
        });
        const application = await startApplication(records);

        const response = await fetch(`${application.url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                process: "content-processing",
                version: "v1",
                input: { content: "   " },
            }),
        });
        const result = (await response.json()) as ProcessRunResult;

        expect(response.status).toBe(400);
        expect(await records.find(result.runId)).toEqual({
            schemaVersion: 1,
            recordedAt: "2026-08-08T01:00:00.000Z",
            runId: result.runId,
            process: "content-processing",
            version: "v1",
            status: "failed",
            errorCode: "INVALID_INPUT",
        });
    });

    it("bounds memory and returns defensive record copies", async () => {
        const records = createInMemoryProcessRunRecords({
            maxRecords: 2,
            content: "accepted-input-and-output",
            clock: () => "2026-08-08T01:00:00.000Z",
        });
        const input = { content: "first input" };
        const output = { content: "first output" };
        const first = succeededRun(
            "00000000-0000-4000-8000-000000000001",
            output,
        );
        records.record({ result: first, acceptedRequest: { input } });
        input.content = "mutated input";
        output.content = "mutated output";

        const firstRead = await records.find(first.runId);
        expect(firstRead?.content).toEqual({
            input: { content: "first input" },
            output: { content: "first output" },
        });
        (firstRead?.content?.input as { content: string }).content =
            "changed copy";
        expect((await records.find(first.runId))?.content?.input).toEqual({
            content: "first input",
        });

        const second = succeededRun("00000000-0000-4000-8000-000000000002");
        const third = succeededRun("00000000-0000-4000-8000-000000000003");
        records.record({ result: second });
        records.record({ result: third });

        expect(await records.find(first.runId)).toBeUndefined();
        expect(await records.find(second.runId)).toBeDefined();
        expect(await records.find(third.runId)).toBeDefined();
    });

    it("does not let recording failures change the process result", async () => {
        const adapter: ProcessRunRecordAdapter = {
            store: async () => {
                throw new Error("record backend unavailable");
            },
            find: async () => undefined,
        };
        const records = createProcessRunRecords({ adapter });
        const application = await startApplication(records);

        const response = await fetch(`${application.url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                process: "content-processing",
                version: "v1",
                input: { content: "launch offer" },
            }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            process: "content-processing",
            version: "v1",
            status: "succeeded",
            output: { content: "Processed: launch offer" },
        });
    });

    it("rejects an unbounded in-memory configuration", () => {
        expect(() =>
            createInMemoryProcessRunRecords({ maxRecords: 0 }),
        ).toThrow("Process Run Record capacity must be a positive integer");
    });
});

async function startApplication(
    runRecords: ProcessRunRecords,
): Promise<{ url: string }> {
    const application = createProcessingApplication({
        executor: createBusinessProcessExecutor({
            contentProcessing: {
                process: async (input) => ({
                    content: `Processed: ${input.content}`,
                }),
            },
            runRecords,
        }),
    });
    runningApplications.push(application);
    return application.listen();
}

function succeededRun(
    runId: string,
    output = { content: "processed" },
): Extract<ProcessRunResult, { status: "succeeded" }> {
    return {
        runId,
        process: "content-processing",
        version: "v1",
        status: "succeeded",
        output,
    };
}
