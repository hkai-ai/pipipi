import {
    createServer,
    type RequestListener,
    type Server,
    request as sendHttpRequest,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import {
    createProcessingRequestListener,
    type ProcessingHttpOptions,
} from "../src/api/http.js";
import {
    createProcessExecutor,
    type ProcessRuntimeOptions,
} from "../src/processes/catalog.js";
import { ContentProcessingUnavailable } from "../src/processes/content/capability.js";

type RunningService = {
    url: string;
    close: () => Promise<void>;
};

const runningServices: RunningService[] = [];

afterEach(async () => {
    await Promise.all(
        runningServices.splice(0).map((service) => service.close()),
    );
});

describe("controlled MVP HTTP boundary", () => {
    it("reports health without executing a business dependency", async () => {
        let capabilityCalls = 0;
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => {
                    capabilityCalls += 1;
                    return { content: "unexpected" };
                },
            },
        });

        const response = await fetch(`${service.url}/healthz`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(await response.json()).toEqual({ status: "ok" });
        expect(capabilityCalls).toBe(0);
    });

    it("returns a safe error when the process executor rejects unexpectedly", async () => {
        const sensitiveFailure = "provider key secret-value was rejected";
        const records: unknown[] = [];
        let monotonicCalls = 0;
        let executionCalls = 0;
        const service = await startRequestListener(
            createProcessingRequestListener(
                {
                    execute: async () => {
                        executionCalls += 1;
                        if (executionCalls === 1)
                            throw new Error(sensitiveFailure);
                        return {
                            runId: "00000000-0000-4000-8000-000000000001",
                            process: "content-processing",
                            version: "v1",
                            status: "succeeded",
                            output: { content: "recovered" },
                        };
                    },
                },
                {
                    maxConcurrentExecutions: 1,
                    logSink: (record) => records.push(record),
                    clock: {
                        timestamp: () => "2026-08-08T00:00:00.000Z",
                        monotonicMilliseconds: () =>
                            monotonicCalls++ === 0 ? 20 : 55,
                    },
                },
            ),
        );

        const response = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                process: "content-processing",
                version: "v1",
                input: { content: "launch offer" },
            }),
            signal: AbortSignal.timeout(1_000),
        });
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body).toEqual({
            status: "failed",
            error: {
                code: "INTERNAL_ERROR",
                message: "The request could not be completed",
            },
        });
        expect(JSON.stringify(body)).not.toContain(sensitiveFailure);
        expect(records).toEqual([
            {
                event: "http_request_failed",
                timestamp: "2026-08-08T00:00:00.000Z",
                httpStatus: 500,
                errorCode: "INTERNAL_ERROR",
                durationMs: 35,
            },
        ]);
        expect(JSON.stringify(records)).not.toContain(sensitiveFailure);

        const recoveredResponse = await executeContent(service.url, "retry");
        expect(recoveredResponse.status).toBe(200);
        expect((await recoveredResponse.json()).output).toEqual({
            content: "recovered",
        });
        expect(executionCalls).toBe(2);
    });

    it("rejects a non-JSON execution request before business execution", async () => {
        let capabilityCalls = 0;
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => {
                    capabilityCalls += 1;
                    return { content: "unexpected" };
                },
            },
        });

        const response = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: JSON.stringify({
                process: "content-processing",
                version: "v1",
                input: { content: "launch offer" },
            }),
        });

        expect(response.status).toBe(415);
        expect(await response.json()).toEqual({
            status: "failed",
            error: {
                code: "UNSUPPORTED_MEDIA_TYPE",
                message: "Content-Type must be application/json",
            },
        });
        expect(capabilityCalls).toBe(0);
    });

    it("rejects a declared request body larger than the byte limit", async () => {
        let capabilityCalls = 0;
        const submittedContent = "sensitive-".repeat(20);
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => {
                    capabilityCalls += 1;
                    return { content: "unexpected" };
                },
            },
            http: { maxRequestBodyBytes: 64 },
        });

        const response = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                process: "content-processing",
                version: "v1",
                input: { content: submittedContent },
            }),
        });
        const body = await response.json();

        expect(response.status).toBe(413);
        expect(body).toEqual({
            status: "failed",
            error: {
                code: "REQUEST_TOO_LARGE",
                message: "Request body exceeds the configured limit",
            },
        });
        expect(JSON.stringify(body)).not.toContain(submittedContent);
        expect(capabilityCalls).toBe(0);
    });

    it("accepts JSON media types with charset parameters", async () => {
        const service = await startProcessingService({
            contentProcessing: {
                process: async (input) => ({
                    content: `Processed: ${input.content}`,
                }),
            },
        });

        const response = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json; charset=UTF-8" },
            body: JSON.stringify({
                process: "content-processing",
                version: "v1",
                input: { content: "launch offer" },
            }),
        });

        expect(response.status).toBe(200);
        expect((await response.json()).output).toEqual({
            content: "Processed: launch offer",
        });
    });

    it("rejects a chunked request after its streamed body crosses the limit", async () => {
        let capabilityCalls = 0;
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => {
                    capabilityCalls += 1;
                    return { content: "unexpected" };
                },
            },
            http: { maxRequestBodyBytes: 80 },
        });
        const requestBody = JSON.stringify({
            process: "content-processing",
            version: "v1",
            input: { content: "chunked-sensitive-content".repeat(10) },
        });

        const response = await postChunkedJson(service.url, [
            requestBody.slice(0, 50),
            requestBody.slice(50),
        ]);

        expect(response.status).toBe(413);
        expect(response.body).toEqual({
            status: "failed",
            error: {
                code: "REQUEST_TOO_LARGE",
                message: "Request body exceeds the configured limit",
            },
        });
        expect(capabilityCalls).toBe(0);
    });

    it("measures the request limit in bytes for multi-byte JSON", async () => {
        let capabilityCalls = 0;
        const requestBody = JSON.stringify({
            process: "content-processing",
            version: "v1",
            input: { content: "你".repeat(40) },
        });
        const maxRequestBodyBytes = requestBody.length + 1;
        expect(Buffer.byteLength(requestBody)).toBeGreaterThan(
            maxRequestBodyBytes,
        );
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => {
                    capabilityCalls += 1;
                    return { content: "unexpected" };
                },
            },
            http: { maxRequestBodyBytes },
        });

        const response = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: requestBody,
        });

        expect(response.status).toBe(413);
        expect(capabilityCalls).toBe(0);
    });

    it("rejects excess execution immediately and accepts work after a slot releases", async () => {
        const firstGate = createDeferred<{ content: string }>();
        const secondGate = createDeferred<{ content: string }>();
        const started: string[] = [];
        const service = await startProcessingService({
            contentProcessing: {
                process: async (input) => {
                    started.push(input.content);
                    if (input.content === "first") return firstGate.promise;
                    if (input.content === "second") return secondGate.promise;
                    return { content: `Processed: ${input.content}` };
                },
            },
            http: { maxConcurrentExecutions: 2 },
        });
        const firstRequest = executeContent(service.url, "first");
        const secondRequest = executeContent(service.url, "second");

        try {
            await expect.poll(() => started.length).toBe(2);

            const rejectedResponse = await executeContent(service.url, "third");

            expect(rejectedResponse.status).toBe(503);
            expect(rejectedResponse.headers.get("retry-after")).toBe("1");
            expect(await rejectedResponse.json()).toEqual({
                status: "failed",
                error: {
                    code: "SERVICE_BUSY",
                    message: "Service is at capacity",
                },
            });
            expect(started).toEqual(["first", "second"]);

            firstGate.resolve({ content: "Processed: first" });
            expect((await firstRequest).status).toBe(200);

            const acceptedResponse = await executeContent(
                service.url,
                "after-capacity",
            );
            expect(acceptedResponse.status).toBe(200);
            expect((await acceptedResponse.json()).output).toEqual({
                content: "Processed: after-capacity",
            });
        } finally {
            firstGate.resolve({ content: "Processed: first" });
            secondGate.resolve({ content: "Processed: second" });
            await Promise.allSettled([firstRequest, secondRequest]);
        }
    });

    it("emits one allowlisted completion record for a successful process run", async () => {
        const records: unknown[] = [];
        let monotonicCalls = 0;
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => ({ content: "sensitive business output" }),
            },
            http: {
                logSink: (record) => records.push(record),
                clock: {
                    timestamp: () => "2026-08-08T00:00:00.000Z",
                    monotonicMilliseconds: () =>
                        monotonicCalls++ === 0 ? 100 : 142,
                },
            },
        });

        const response = await executeContent(
            service.url,
            "sensitive business input",
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(records).toEqual([
            {
                event: "process_run_completed",
                timestamp: "2026-08-08T00:00:00.000Z",
                runId: body.runId,
                process: "content-processing",
                version: "v1",
                status: "succeeded",
                durationMs: 42,
            },
        ]);
        expect(JSON.stringify(records)).not.toContain(
            "sensitive business input",
        );
        expect(JSON.stringify(records)).not.toContain(
            "sensitive business output",
        );
    });

    it("records the caller's request id without echoing it back", async () => {
        const records: unknown[] = [];
        let monotonicCalls = 0;
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => ({ content: "output" }),
            },
            http: {
                logSink: (record) => records.push(record),
                clock: {
                    timestamp: () => "2026-08-08T00:00:00.000Z",
                    monotonicMilliseconds: () =>
                        monotonicCalls++ === 0 ? 100 : 142,
                },
            },
        });

        const response = await executeContent(service.url, "input", {
            "x-request-id": "caller-trace-01",
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(response.headers.get("x-request-id")).toBeNull();
        expect(body).not.toHaveProperty("requestId");
        expect(records).toEqual([
            {
                event: "process_run_completed",
                timestamp: "2026-08-08T00:00:00.000Z",
                runId: body.runId,
                process: "content-processing",
                version: "v1",
                status: "succeeded",
                durationMs: 42,
                requestId: "caller-trace-01",
            },
        ]);
    });

    it("records the caller's request id on rejections that carry no runId", async () => {
        const records: unknown[] = [];
        let monotonicValue = 0;
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => ({ content: "unexpected" }),
            },
            http: {
                logSink: (record) => records.push(record),
                clock: {
                    timestamp: () => "2026-08-08T00:00:00.000Z",
                    monotonicMilliseconds: () => {
                        const value = monotonicValue;
                        monotonicValue += 10;
                        return value;
                    },
                },
            },
        });

        const response = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: {
                "content-type": "text/plain",
                "x-request-id": "caller-trace-02",
            },
            body: "rejected before execution",
        });

        expect(response.status).toBe(415);
        expect(records).toEqual([
            {
                event: "http_request_rejected",
                timestamp: "2026-08-08T00:00:00.000Z",
                httpStatus: 415,
                errorCode: "UNSUPPORTED_MEDIA_TYPE",
                durationMs: 10,
                requestId: "caller-trace-02",
            },
        ]);
    });

    it("drops an unusable request id without changing the result", async () => {
        const unusableRequestIds = [
            "",
            " ",
            "trace with spaces",
            'trace"quoted',
            "duplicate-a, duplicate-b",
            "x".repeat(201),
        ];
        const records: Array<Record<string, unknown>> = [];
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => ({ content: "output" }),
            },
            http: {
                logSink: (record) =>
                    records.push(record as Record<string, unknown>),
            },
        });

        for (const requestId of unusableRequestIds) {
            const response = await executeContent(service.url, "input", {
                "x-request-id": requestId,
            });

            expect(response.status).toBe(200);
        }

        expect(records).toHaveLength(unusableRequestIds.length);
        for (const record of records) {
            expect(record.status).toBe("succeeded");
            expect(record).not.toHaveProperty("requestId");
        }
        expect(JSON.stringify(records)).not.toContain("duplicate-a");
    });

    it("emits minimal records for media, body, and capacity rejections", async () => {
        const records: unknown[] = [];
        const executionGate = createDeferred<{ content: string }>();
        let executionStarted = false;
        let monotonicValue = 0;
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => {
                    executionStarted = true;
                    return executionGate.promise;
                },
            },
            http: {
                maxRequestBodyBytes: 100,
                maxConcurrentExecutions: 1,
                logSink: (record) => records.push(record),
                clock: {
                    timestamp: () => "2026-08-08T00:00:00.000Z",
                    monotonicMilliseconds: () => {
                        const value = monotonicValue;
                        monotonicValue += 10;
                        return value;
                    },
                },
            },
        });

        const mediaResponse = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "private request content",
        });
        const bodyResponse = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "x".repeat(101),
        });
        const activeExecution = executeContent(service.url, "held execution");

        try {
            await expect.poll(() => executionStarted).toBe(true);
            const capacityResponse = await executeContent(
                service.url,
                "private rejected content",
            );

            expect(mediaResponse.status).toBe(415);
            expect(bodyResponse.status).toBe(413);
            expect(capacityResponse.status).toBe(503);
            expect(records).toEqual([
                {
                    event: "http_request_rejected",
                    timestamp: "2026-08-08T00:00:00.000Z",
                    httpStatus: 415,
                    errorCode: "UNSUPPORTED_MEDIA_TYPE",
                    durationMs: 10,
                },
                {
                    event: "http_request_rejected",
                    timestamp: "2026-08-08T00:00:00.000Z",
                    httpStatus: 413,
                    errorCode: "REQUEST_TOO_LARGE",
                    durationMs: 10,
                },
                {
                    event: "http_request_rejected",
                    timestamp: "2026-08-08T00:00:00.000Z",
                    httpStatus: 503,
                    errorCode: "SERVICE_BUSY",
                    durationMs: 10,
                },
            ]);
            expect(JSON.stringify(records)).not.toContain("private");
        } finally {
            executionGate.resolve({ content: "held execution completed" });
            await activeExecution;
        }
    });

    it("emits one safe completion record for a failed process run", async () => {
        const records: unknown[] = [];
        const sensitiveFailure = "stack and api-key-secret must stay private";
        const service = await startProcessingService({
            contentProcessing: {
                process: async () => {
                    throw new Error(sensitiveFailure);
                },
            },
            http: { logSink: (record) => records.push(record) },
        });

        const response = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer authorization-secret",
            },
            body: JSON.stringify({
                process: "content-processing",
                version: "v1",
                input: { content: "prompt-secret and tool-input-secret" },
            }),
        });
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(records).toHaveLength(1);
        expect(records[0]).toEqual({
            event: "process_run_completed",
            timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            runId: body.runId,
            process: "content-processing",
            version: "v1",
            status: "failed",
            durationMs: expect.any(Number),
            errorCode: "INTERNAL_ERROR",
        });
        const serializedRecords = JSON.stringify(records);
        for (const secret of [
            sensitiveFailure,
            "api-key-secret",
            "authorization-secret",
            "prompt-secret",
            "tool-input-secret",
        ]) {
            expect(serializedRecords).not.toContain(secret);
        }
    });

    it("restores capacity after a process failure and a timeout", async () => {
        const records: Array<{ event: string; errorCode?: string }> = [];
        const service = await startProcessingService({
            contentProcessing: {
                process: async (input) => {
                    if (input.content === "dependency-failure") {
                        throw new ContentProcessingUnavailable();
                    }
                    if (input.content === "timeout")
                        return new Promise(() => {});
                    return { content: `Processed: ${input.content}` };
                },
            },
            processTimeoutMs: 20,
            http: {
                maxConcurrentExecutions: 1,
                logSink: (record) => records.push(record),
            },
        });

        const failureResponse = await executeContent(
            service.url,
            "dependency-failure",
        );
        const afterFailureResponse = await executeContent(
            service.url,
            "after-failure",
        );
        const timeoutResponse = await executeContent(service.url, "timeout");
        const afterTimeoutResponse = await executeContent(
            service.url,
            "after-timeout",
        );

        expect(failureResponse.status).toBe(502);
        expect(afterFailureResponse.status).toBe(200);
        expect(timeoutResponse.status).toBe(504);
        expect(afterTimeoutResponse.status).toBe(200);
        expect(records.map((record) => record.errorCode)).toEqual([
            "DEPENDENCY_FAILURE",
            undefined,
            "PROCESS_TIMEOUT",
            undefined,
        ]);
    });

    it("does not spend execution capacity on health or transport rejections", async () => {
        let capabilityCalls = 0;
        const service = await startProcessingService({
            contentProcessing: {
                process: async (input) => {
                    capabilityCalls += 1;
                    return { content: `Processed: ${input.content}` };
                },
            },
            http: {
                maxConcurrentExecutions: 1,
                maxRequestBodyBytes: 100,
                logSink: () => {},
            },
        });

        const healthResponse = await fetch(`${service.url}/healthz`);
        const mediaResponse = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "not JSON",
        });
        const bodyResponse = await fetch(`${service.url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "x".repeat(101),
        });
        const validResponse = await executeContent(
            service.url,
            "still accepted",
        );

        expect(healthResponse.status).toBe(200);
        expect(mediaResponse.status).toBe(415);
        expect(bodyResponse.status).toBe(413);
        expect(validResponse.status).toBe(200);
        expect(capabilityCalls).toBe(1);
    });

    it("keeps parallel Agent-backed requests isolated by sentinel content", async () => {
        const agentInputs: string[] = [];
        const capabilityInputs: string[] = [];
        const service = await startProcessingService({
            contentProcessing: {
                process: async (input) => {
                    capabilityInputs.push(input.content);
                    return { content: `Result for ${input.content}` };
                },
            },
            agent: {
                optimize: async (request) => {
                    agentInputs.push(request.content);
                    await new Promise((resolve) =>
                        setTimeout(
                            resolve,
                            request.content.endsWith("alpha") ? 15 : 5,
                        ),
                    );
                    return request.capability.process(
                        { content: `Tool input ${request.content}` },
                        {
                            signal: request.signal,
                            idempotencyKey: request.idempotencyKey,
                        },
                    );
                },
            },
            processes: { contentProcessing: { mode: "agent" } },
            http: { maxConcurrentExecutions: 2, logSink: () => {} },
        });

        const [alphaResponse, betaResponse] = await Promise.all([
            executeContent(service.url, "sentinel-alpha"),
            executeContent(service.url, "sentinel-beta"),
        ]);
        const [alphaBody, betaBody] = await Promise.all([
            alphaResponse.json(),
            betaResponse.json(),
        ]);

        expect(alphaResponse.status).toBe(200);
        expect(betaResponse.status).toBe(200);
        expect(alphaBody.output).toEqual({
            content: "Result for Tool input sentinel-alpha",
        });
        expect(betaBody.output).toEqual({
            content: "Result for Tool input sentinel-beta",
        });
        expect(agentInputs.sort()).toEqual(["sentinel-alpha", "sentinel-beta"]);
        expect(capabilityInputs.sort()).toEqual([
            "Tool input sentinel-alpha",
            "Tool input sentinel-beta",
        ]);
    });

    it("writes default production records as one-line JSON on stdout", async () => {
        const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            const service = await startProcessingService({
                contentProcessing: {
                    process: async () => ({ content: "processed" }),
                },
            });

            const response = await executeContent(service.url, "launch offer");

            expect(response.status).toBe(200);
            expect(stdout).toHaveBeenCalledTimes(1);
            const line = stdout.mock.calls[0]?.[0];
            expect(typeof line).toBe("string");
            expect(line).not.toContain("\n");
            expect(JSON.parse(String(line))).toMatchObject({
                event: "process_run_completed",
                process: "content-processing",
                version: "v1",
                status: "succeeded",
            });
        } finally {
            stdout.mockRestore();
        }
    });
});

async function startProcessingService(
    options: ProcessRuntimeOptions & { http?: ProcessingHttpOptions },
): Promise<RunningService> {
    const { http, ...executorOptions } = options;
    const application = createProcessingApplication({
        executor: createProcessExecutor(executorOptions),
        http,
    });
    const { url } = await application.listen();
    const service = { url, close: application.close };
    runningServices.push(service);
    return service;
}

async function startRequestListener(
    listener: RequestListener,
): Promise<RunningService> {
    const server = createServer(listener);
    const url = await listen(server);
    const service = { url, close: () => close(server) };
    runningServices.push(service);
    return service;
}

async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected an IP address for test server");
    }
    return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

async function postChunkedJson(
    serviceUrl: string,
    chunks: readonly string[],
): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
        const request = sendHttpRequest(
            new URL("/execute", serviceUrl),
            {
                method: "POST",
                headers: { "content-type": "application/json" },
            },
            (response) => {
                const responseChunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) =>
                    responseChunks.push(chunk),
                );
                response.once("error", reject);
                response.once("end", () => {
                    resolve({
                        status: response.statusCode ?? 0,
                        body: JSON.parse(
                            Buffer.concat(responseChunks).toString("utf8"),
                        ),
                    });
                });
            },
        );
        request.once("error", reject);
        for (const chunk of chunks) request.write(chunk);
        request.end();
    });
}

function executeContent(
    serviceUrl: string,
    content: string,
    headers: Record<string, string> = {},
): Promise<Response> {
    return fetch(`${serviceUrl}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
            process: "content-processing",
            version: "v1",
            input: { content },
        }),
    });
}

function createDeferred<Value>(): {
    promise: Promise<Value>;
    resolve: (value: Value) => void;
} {
    let resolvePromise: ((value: Value) => void) | undefined;
    const promise = new Promise<Value>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (value) => resolvePromise?.(value),
    };
}
