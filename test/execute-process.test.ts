import { afterEach, describe, expect, it } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import {
    recordKnownCost,
    recordUnknownCost,
} from "../src/process-runtime/cost.js";
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
                message:
                    "sample-text/v1 input validation failed: /content must be at least 1 characters",
                details: [
                    {
                        path: "/content",
                        keyword: "minLength",
                        message: "must be at least 1 characters",
                    },
                ],
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
                message:
                    "Request input validation failed: / must be a valid JSON object",
                details: [
                    {
                        path: "/",
                        keyword: "type",
                        message: "must be a valid JSON object",
                    },
                ],
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
                message:
                    "sample-text/v1 input validation failed: /steps is not an allowed property",
                details: [
                    {
                        path: "/steps",
                        keyword: "additionalProperties",
                        message: "is not an allowed property",
                    },
                ],
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

    describe("run cost", () => {
        const request = {
            process: "sample-text",
            version: "v1",
            input: { content: "launch offer" },
        };
        async function costOf(process: () => Promise<{ content: string }>) {
            const service = await startProcessingService({
                registrations: [createSampleTextRegistration({ process })],
            });
            const response = await executeProcess(service.url, request);
            return { status: response.status, body: await response.json() };
        }

        it("sums provider costs on success and reports a complete run", async () => {
            const { body } = await costOf(async () => {
                recordKnownCost(0.01, "provider");
                recordKnownCost(0.0023, "provider");
                return { content: "ok" };
            });
            expect(body.cost).toEqual({
                currency: "USD",
                amount: 0.0123,
                source: "provider",
                complete: true,
            });
        });

        it("keeps the cost already incurred when the run fails", async () => {
            const { status, body } = await costOf(async () => {
                recordKnownCost(0.05, "provider");
                throw new SampleTextUnavailable();
            });
            expect(status).toBe(502);
            expect(body.status).toBe("failed");
            expect(body.cost).toEqual({
                currency: "USD",
                amount: 0.05,
                source: "provider",
                complete: true,
            });
        });

        it("marks mixed sources and an unknown call as a lower bound", async () => {
            const { body } = await costOf(async () => {
                recordKnownCost(0.25, "estimate");
                recordKnownCost(0.5, "provider");
                recordUnknownCost();
                return { content: "ok" };
            });
            expect(body.cost).toEqual({
                currency: "USD",
                amount: 0.75,
                source: "mixed",
                complete: false,
            });
        });

        it("counts an explicit provider zero but omits cost when nothing is known", async () => {
            const free = await costOf(async () => {
                recordKnownCost(0, "provider");
                return { content: "ok" };
            });
            expect(free.body.cost).toEqual({
                currency: "USD",
                amount: 0,
                source: "provider",
                complete: true,
            });
            const unknown = await costOf(async () => {
                recordUnknownCost();
                return { content: "ok" };
            });
            expect("cost" in unknown.body).toBe(false);
        });

        it("rejects invalid input without a cost field", async () => {
            const service = await startProcessingService({
                registrations: [createSampleTextRegistration(unusedCapability)],
            });
            const response = await executeProcess(service.url, {
                ...request,
                input: { content: "  " },
            });
            expect("cost" in (await response.json())).toBe(false);
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
