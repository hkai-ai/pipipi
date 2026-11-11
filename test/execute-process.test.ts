import { afterEach, describe, expect, it } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import {
    createProcessExecutor,
    type ProcessRuntimeOptions,
} from "../src/processes/catalog.js";
import {
    createSampleTextRegistration,
    type SampleTextCapability,
    SampleTextUnavailable,
} from "./support/sample-text.js";

type RunningServer = {
    url: string;
    close: () => Promise<void>;
};

const runningServers: RunningServer[] = [];
const unusedCapability: SampleTextCapability = {
    process: async () => {
        throw new Error("The capability should not run for this request");
    },
};

afterEach(async () => {
    await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

describe("business process execution", () => {
    it("returns validated output and passes the runId as the idempotency key", async () => {
        const calls: { content: string; idempotencyKey: string }[] = [];
        const processingService = await startProcessingService({
            registrations: [
                createSampleTextRegistration({
                    process: async (input, options) => {
                        calls.push({
                            content: input.content,
                            idempotencyKey: options.idempotencyKey,
                        });
                        return { content: "  Refined campaign copy  " };
                    },
                }),
            ],
        });

        const response = await executeProcess(processingService.url, {
            process: "sample-text",
            version: "v1",
            input: { content: "  launch   offer  " },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            process: "sample-text",
            version: "v1",
            status: "succeeded",
            output: { content: "Refined campaign copy" },
        });
        expect(calls).toEqual([
            { content: "launch offer", idempotencyKey: body.runId },
        ]);
    });

    it("maps invalid Process Definition output to a stable error", async () => {
        const processingService = await startProcessingService({
            registrations: [
                createSampleTextRegistration({
                    process: async () => ({ content: "   " }),
                }),
            ],
        });

        const response = await executeProcess(processingService.url, {
            process: "sample-text",
            version: "v1",
            input: { content: "launch offer" },
        });

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
            runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            process: "sample-text",
            version: "v1",
            status: "failed",
            error: {
                code: "INVALID_OUTPUT",
                message: "The process produced an invalid output",
            },
        });
    });

    it("rejects invalid business input with a stable error", async () => {
        const processingService = await startProcessingService({
            registrations: [createSampleTextRegistration(unusedCapability)],
        });

        const response = await executeProcess(processingService.url, {
            process: "sample-text",
            version: "v1",
            input: { content: "   \n  " },
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            process: "sample-text",
            version: "v1",
            status: "failed",
            error: {
                code: "INVALID_INPUT",
                message: "The process input is invalid",
            },
        });
    });

    it("treats malformed JSON as invalid input", async () => {
        const processingService = await startProcessingService({
            registrations: [createSampleTextRegistration(unusedCapability)],
        });

        const response = await postExecution(processingService.url, "{");

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            status: "failed",
            error: {
                code: "INVALID_INPUT",
                message: "The process input is invalid",
            },
        });
    });

    it("rejects caller-supplied process mechanics", async () => {
        const processingService = await startProcessingService({
            registrations: [createSampleTextRegistration(unusedCapability)],
        });

        const response = await executeProcess(processingService.url, {
            process: "sample-text",
            version: "v1",
            input: { content: "launch offer" },
            steps: [{ type: "api", url: "https://untrusted.example/process" }],
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            process: "sample-text",
            version: "v1",
            status: "failed",
            error: {
                code: "INVALID_INPUT",
                message: "The process input is invalid",
            },
        });
    });

    it("rejects an unknown process version without choosing a fallback", async () => {
        const processingService = await startProcessingService({
            registrations: [createSampleTextRegistration(unusedCapability)],
        });

        const response = await executeProcess(processingService.url, {
            process: "sample-text",
            version: "v2",
            input: { content: "launch offer" },
        });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            process: "sample-text",
            version: "v2",
            status: "failed",
            error: {
                code: "PROCESS_NOT_FOUND",
                message: "The requested process version is not registered",
            },
        });
    });

    it("maps an unavailable dependency to a safe dependency error", async () => {
        const processingService = await startProcessingService({
            registrations: [
                createSampleTextRegistration({
                    process: async () => {
                        throw new SampleTextUnavailable();
                    },
                }),
            ],
        });

        const response = await executeProcess(processingService.url, {
            process: "sample-text",
            version: "v1",
            input: { content: "launch offer" },
        });

        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
            runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            process: "sample-text",
            version: "v1",
            status: "failed",
            error: {
                code: "DEPENDENCY_FAILURE",
                message: "A required business service is unavailable",
            },
        });
    });

    it("enforces the total process time limit", async () => {
        const processingService = await startProcessingService({
            registrations: [
                createSampleTextRegistration({
                    process: () => new Promise(() => {}),
                }),
            ],
            processTimeoutMs: 20,
        });

        const response = await executeProcess(
            processingService.url,
            {
                process: "sample-text",
                version: "v1",
                input: { content: "launch offer" },
            },
            AbortSignal.timeout(1_000),
        );

        expect(response.status).toBe(504);
        expect(await response.json()).toEqual({
            runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            process: "sample-text",
            version: "v1",
            status: "failed",
            error: {
                code: "PROCESS_TIMEOUT",
                message: "流程超过执行时限",
            },
        });
    });
});

async function startProcessingService(
    options: ProcessRuntimeOptions,
): Promise<RunningServer> {
    const application = createProcessingApplication({
        executor: createProcessExecutor(options),
    });
    const service = await application.listen();
    const runningService = { url: service.url, close: application.close };
    runningServers.push(runningService);
    return runningService;
}

async function executeProcess(
    serviceUrl: string,
    request: unknown,
    signal?: AbortSignal,
): Promise<Response> {
    return postExecution(serviceUrl, JSON.stringify(request), signal);
}

async function postExecution(
    serviceUrl: string,
    body: string,
    signal?: AbortSignal,
): Promise<Response> {
    return fetch(`${serviceUrl}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
    });
}
