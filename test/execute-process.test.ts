import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentOptimizationAgentRuntime } from "../src/processes/agent.js";
import { createProcessingApplication } from "../src/api/application.js";
import { ContentProcessingUnavailable } from "../src/processes/content-capability.js";
import {
  createBusinessProcessExecutor,
  type BusinessProcessExecutorOptions,
} from "../src/processes/catalog.js";
import {
  HttpContentProcessingCapability,
  type ContentProcessingCapability,
} from "../src/processes/content.js";

type RunningServer = {
  url: string;
  close: () => Promise<void>;
};

const runningServers: RunningServer[] = [];
const unusedContentProcessing: ContentProcessingCapability = {
  process: async () => {
    throw new Error("Content processing should not run for this request");
  },
};

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

describe("business process execution", () => {
  it("rejects incomplete Process Registration composition at startup", () => {
    expect(() =>
      createBusinessProcessExecutor({
        contentProcessing: undefined as unknown as ContentProcessingCapability,
      }),
    ).toThrow("Content Processing Capability is required");
    expect(() =>
      createBusinessProcessExecutor({
        contentProcessing: unusedContentProcessing,
        processes: {
          contentProcessing: {
            mode: "unsupported" as "direct",
          },
        },
      }),
    ).toThrow("Content processing mode must be direct or agent");
    expect(() =>
      createBusinessProcessExecutor({
        contentProcessing: unusedContentProcessing,
        processes: { contentProcessing: { mode: "agent" } },
      }),
    ).toThrow("Agent Runtime is required when Agent mode is enabled");
    expect(() =>
      createBusinessProcessExecutor({
        contentProcessing: unusedContentProcessing,
        processes: { titledContentProcessing: { separator: "" } },
      }),
    ).toThrow("The titled content separator cannot be empty");
  });

  it("returns validated content from the direct business API process", async () => {
    let downstreamIdempotencyKey: string | undefined;
    const businessApi = await startServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/process") {
        response.writeHead(404).end();
        return;
      }

      const requestBody = await readJson(request);
      const idempotencyHeader = request.headers["idempotency-key"];
      downstreamIdempotencyKey = Array.isArray(idempotencyHeader)
        ? idempotencyHeader[0]
        : idempotencyHeader;
      const expectedBody = { content: "launch offer" };
      if (JSON.stringify(requestBody) !== JSON.stringify(expectedBody)) {
        response.writeHead(422).end();
        return;
      }

      writeJson(response, 200, { content: "  Refined campaign copy  " });
    });
    const processingService = await startHttpBackedService(businessApi.url);

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "  launch   offer  " },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
      version: "v1",
      status: "succeeded",
      output: { content: "Refined campaign copy" },
    });
    expect(downstreamIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps invalid Process Definition output to a stable error", async () => {
    const processingService = await startProcessingService({
      contentProcessing: {
        process: async () => ({ content: "   " }),
      },
    });

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "launch offer" },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
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
      contentProcessing: unusedContentProcessing,
    });

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "   \n  " },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
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
      contentProcessing: unusedContentProcessing,
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
      contentProcessing: unusedContentProcessing,
    });

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "launch offer" },
      steps: [{ type: "api", url: "https://untrusted.example/process" }],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
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
      contentProcessing: unusedContentProcessing,
    });

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v2",
      input: { content: "launch offer" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
      version: "v2",
      status: "failed",
      error: {
        code: "PROCESS_NOT_FOUND",
        message: "The requested process version is not registered",
      },
    });
  });

  it("maps a remote business API failure to a safe dependency error", async () => {
    const businessApi = await startServer((_request, response) => {
      writeJson(response, 503, {
        internalMessage: "database credentials were rejected",
      });
    });
    const processingService = await startHttpBackedService(businessApi.url);

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "launch offer" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
      version: "v1",
      status: "failed",
      error: {
        code: "DEPENDENCY_FAILURE",
        message: "A required business service is unavailable",
      },
    });
  });

  it("maps an invalid business API response to a dependency error", async () => {
    const businessApi = await startServer((_request, response) => {
      writeJson(response, 200, { unexpected: "internal response" });
    });
    const processingService = await startHttpBackedService(businessApi.url);

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "launch offer" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
      version: "v1",
      status: "failed",
      error: {
        code: "DEPENDENCY_FAILURE",
        message: "A required business service is unavailable",
      },
    });
  });

  it("times out a stalled business API dependency", async () => {
    const businessApi = await startServer((request, response) => {
      request.once("close", () => response.destroy());
    });
    const processingService = await startHttpBackedService(businessApi.url, {
      businessApiTimeoutMs: 20,
    });

    const response = await executeProcess(
      processingService.url,
      {
        process: "content-processing",
        version: "v1",
        input: { content: "launch offer" },
      },
      AbortSignal.timeout(1_000),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
      version: "v1",
      status: "failed",
      error: {
        code: "DEPENDENCY_FAILURE",
        message: "A required business service is unavailable",
      },
    });
  });

  it("enforces the total process time limit", async () => {
    const neverCompletes: ContentProcessingCapability = {
      process: () => new Promise(() => {}),
    };
    const processingService = await startProcessingService({
      contentProcessing: neverCompletes,
      processTimeoutMs: 20,
    });

    const response = await executeProcess(
      processingService.url,
      {
        process: "content-processing",
        version: "v1",
        input: { content: "launch offer" },
      },
      AbortSignal.timeout(1_000),
    );

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
      version: "v1",
      status: "failed",
      error: {
        code: "PROCESS_TIMEOUT",
        message: "The process exceeded its time limit",
      },
    });
  });

  it("can enable Agent optimization without changing the product contract", async () => {
    const requests: string[] = [];
    const agentRuntime: ContentOptimizationAgentRuntime = {
      optimize: async (request) => {
        requests.push(request.content);
        return { content: "  Agent-refined campaign copy  " };
      },
    };
    const processingService = await startProcessingService({
      contentProcessing: unusedContentProcessing,
      agentRuntime,
      processes: { contentProcessing: { mode: "agent" } },
    });

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "  launch   offer  " },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
      version: "v1",
      status: "succeeded",
      output: { content: "Agent-refined campaign copy" },
    });
    expect(requests).toEqual(["launch offer"]);
  });

  it("lets the Agent path call the existing business capability as its Tool", async () => {
    const capabilityInputs: string[] = [];
    const contentProcessing: ContentProcessingCapability = {
      process: async (input) => {
        capabilityInputs.push(input.content);
        return { content: `Business result: ${input.content}` };
      },
    };
    const agentRuntime: ContentOptimizationAgentRuntime = {
      optimize: async (request) =>
        request.contentProcessing.process(
          { content: `Optimize ${request.content}` },
          {
            signal: request.signal,
            idempotencyKey: request.idempotencyKey,
          },
        ),
    };
    const processingService = await startProcessingService({
      contentProcessing,
      agentRuntime,
      processes: { contentProcessing: { mode: "agent" } },
    });

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "launch offer" },
    });

    expect(response.status).toBe(200);
    expect((await response.json()).output).toEqual({
      content: "Business result: Optimize launch offer",
    });
    expect(capabilityInputs).toEqual(["Optimize launch offer"]);
  });

  it("preserves a Business Capability failure from the Agent Tool path", async () => {
    const contentProcessing: ContentProcessingCapability = {
      process: async () => {
        throw new ContentProcessingUnavailable();
      },
    };
    const agentRuntime: ContentOptimizationAgentRuntime = {
      optimize: async (request) =>
        request.contentProcessing.process(
          { content: request.content },
          {
            signal: request.signal,
            idempotencyKey: request.idempotencyKey,
          },
        ),
    };
    const processingService = await startProcessingService({
      contentProcessing,
      agentRuntime,
      processes: { contentProcessing: { mode: "agent" } },
    });

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "launch offer" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: {
        code: "DEPENDENCY_FAILURE",
        message: "A required business service is unavailable",
      },
    });
  });

  it("maps invalid structured Agent output to a stable processing error", async () => {
    const agentRuntime: ContentOptimizationAgentRuntime = {
      optimize: async () => ({ unexpected: "not business content" }),
    };
    const processingService = await startProcessingService({
      contentProcessing: unusedContentProcessing,
      agentRuntime,
      processes: { contentProcessing: { mode: "agent" } },
    });

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "launch offer" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
      version: "v1",
      status: "failed",
      error: {
        code: "AGENT_FAILURE",
        message: "The content optimization agent could not complete the request",
      },
    });
  });

  it("maps Agent execution failures without leaking internal details", async () => {
    const agentRuntime: ContentOptimizationAgentRuntime = {
      optimize: async () => {
        throw new Error("provider key abc-secret was rejected");
      },
    };
    const processingService = await startProcessingService({
      contentProcessing: unusedContentProcessing,
      agentRuntime,
      processes: { contentProcessing: { mode: "agent" } },
    });

    const response = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "launch offer" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "content-processing",
      version: "v1",
      status: "failed",
      error: {
        code: "AGENT_FAILURE",
        message: "The content optimization agent could not complete the request",
      },
    });
  });

  it("routes a second process with its own schemas through the shared capability", async () => {
    const capabilityInputs: string[] = [];
    const contentProcessing: ContentProcessingCapability = {
      process: async (input) => {
        capabilityInputs.push(input.content);
        return { content: `Published: ${input.content}` };
      },
    };
    const processingService = await startProcessingService({
      contentProcessing,
      processes: {
        titledContentProcessing: { separator: " — " },
      },
    });

    const response = await executeProcess(processingService.url, {
      process: "titled-content-processing",
      version: "v1",
      input: { title: "  Launch  ", body: "  body   copy  " },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      process: "titled-content-processing",
      version: "v1",
      status: "succeeded",
      output: {
        title: "Launch",
        content: "Published: Launch — body copy",
      },
    });
    expect(capabilityInputs).toEqual(["Launch — body copy"]);
  });

  it("keeps each process configuration isolated", async () => {
    const agentInputs: string[] = [];
    const capabilityInputs: string[] = [];
    const agentRuntime: ContentOptimizationAgentRuntime = {
      optimize: async (request) => {
        agentInputs.push(request.content);
        return { content: `Agent: ${request.content}` };
      },
    };
    const contentProcessing: ContentProcessingCapability = {
      process: async (input) => {
        capabilityInputs.push(input.content);
        return { content: `Direct: ${input.content}` };
      },
    };
    const processingService = await startProcessingService({
      contentProcessing,
      agentRuntime,
      processes: {
        contentProcessing: { mode: "agent" },
        titledContentProcessing: { separator: ": " },
      },
    });

    const firstResponse = await executeProcess(processingService.url, {
      process: "content-processing",
      version: "v1",
      input: { content: "first" },
    });
    const secondResponse = await executeProcess(processingService.url, {
      process: "titled-content-processing",
      version: "v1",
      input: { title: "Second", body: "process" },
    });

    expect((await firstResponse.json()).output).toEqual({
      content: "Agent: first",
    });
    expect((await secondResponse.json()).output).toEqual({
      title: "Second",
      content: "Direct: Second: process",
    });
    expect(agentInputs).toEqual(["first"]);
    expect(capabilityInputs).toEqual(["Second: process"]);
  });

  it("enforces the second process input schema independently", async () => {
    const processingService = await startProcessingService({
      contentProcessing: unusedContentProcessing,
    });

    const response = await executeProcess(processingService.url, {
      process: "titled-content-processing",
      version: "v1",
      input: { content: "valid only for the first process" },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual({
      code: "INVALID_INPUT",
      message: "The process input is invalid",
    });
  });

  it("rejects an unknown second-process version without version drift", async () => {
    const processingService = await startProcessingService({
      contentProcessing: unusedContentProcessing,
    });

    const response = await executeProcess(processingService.url, {
      process: "titled-content-processing",
      version: "v2",
      input: { title: "Launch", body: "body copy" },
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toEqual({
      code: "PROCESS_NOT_FOUND",
      message: "The requested process version is not registered",
    });
  });
});

async function startHttpBackedService(
  businessApiBaseUrl: string,
  options: { businessApiTimeoutMs?: number; processTimeoutMs?: number } = {},
): Promise<RunningServer> {
  return startProcessingService({
    contentProcessing: new HttpContentProcessingCapability({
      baseUrl: businessApiBaseUrl,
      timeoutMs: options.businessApiTimeoutMs,
    }),
    processTimeoutMs: options.processTimeoutMs,
  });
}

async function startProcessingService(
  options: BusinessProcessExecutorOptions,
): Promise<RunningServer> {
  const application = createProcessingApplication({
    executor: createBusinessProcessExecutor(options),
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

async function startServer(handler: RequestListener): Promise<RunningServer> {
  const server = createServer(handler);
  const url = await listen(server);
  const runningServer = { url, close: () => close(server) };
  runningServers.push(runningServer);
  return runningServer;
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
