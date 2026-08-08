import {
  createServer,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessingApplication } from "../src/application.js";
import { constructProcessingService } from "../src/startup-construction.js";

type RunningServer = {
  url: string;
  close: () => Promise<void>;
};

const runningApplications: ProcessingApplication[] = [];
const runningServers: RunningServer[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    runningApplications.splice(0).map((application) => application.close()),
  );
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

describe("Startup Construction", () => {
  it("constructs the default direct service from an explicit environment", async () => {
    const businessInputs: unknown[] = [];
    const businessApi = await startServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/process") {
        response.writeHead(404).end();
        return;
      }
      businessInputs.push(await readJson(request));
      writeJson(response, 200, { content: "Refined campaign copy" });
    });

    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: `  ${businessApi.url}/legacy-base  `,
    });
    expect(constructed.port).toBe(3000);

    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();

    const healthResponse = await fetch(`${url}/healthz`);
    expect(healthResponse.status).toBe(200);
    expect(businessInputs).toEqual([]);

    const executeResponse = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        process: "content-processing",
        version: "v1",
        input: { content: "Campaign   copy" },
      }),
    });

    expect(executeResponse.status).toBe(200);
    expect(businessInputs).toEqual([{ content: "Campaign copy" }]);
    expect(await executeResponse.json()).toEqual({
      runId: expect.any(String),
      process: "content-processing",
      version: "v1",
      status: "succeeded",
      output: { content: "Refined campaign copy" },
    });
  });

  it("uses the 10000-millisecond Business Capability timeout by default", async () => {
    const businessRequestStarted = deferred<void>();
    const releaseBusinessRequest = deferred<void>();
    const businessApi = await startServer(async (_request, response) => {
      businessRequestStarted.resolve();
      await releaseBusinessRequest.promise;
      if (!response.destroyed) {
        writeJson(response, 200, { content: "Released response" });
      }
    });
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: businessApi.url,
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();
    useControllableAbortTimeouts();
    vi.useFakeTimers();

    let responseSettled = false;
    const responsePromise = executeContentProcess(url).then((response) => {
      responseSettled = true;
      return response;
    });
    await businessRequestStarted.promise;

    try {
      await vi.advanceTimersByTimeAsync(9_999);
      expect(responseSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const response = await responsePromise;
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        status: "failed",
        error: { code: "DEPENDENCY_FAILURE" },
      });
    } finally {
      releaseBusinessRequest.resolve();
    }
  });

  it("uses the 30000-millisecond Process Runner timeout by default", async () => {
    const businessRequestStarted = deferred<void>();
    const releaseBusinessRequest = deferred<void>();
    const businessApi = await startServer(async (_request, response) => {
      businessRequestStarted.resolve();
      await releaseBusinessRequest.promise;
      if (!response.destroyed) {
        writeJson(response, 200, { content: "Released response" });
      }
    });
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: businessApi.url,
      BUSINESS_API_TIMEOUT_MS: "60000",
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();
    useControllableAbortTimeouts();
    vi.useFakeTimers();

    let responseSettled = false;
    const responsePromise = executeContentProcess(url).then((response) => {
      responseSettled = true;
      return response;
    });
    await businessRequestStarted.promise;

    try {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(responseSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const response = await responsePromise;
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({
        status: "failed",
        error: { code: "PROCESS_TIMEOUT" },
      });
    } finally {
      releaseBusinessRequest.resolve();
    }
  });

  it("uses the 262144-byte HTTP request-body limit by default", async () => {
    const businessInputs: unknown[] = [];
    const businessApi = await startServer(async (request, response) => {
      businessInputs.push(await readJson(request));
      writeJson(response, 200, { content: "Accepted boundary request" });
    });
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: businessApi.url,
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();
    const boundaryBody = executeRequestBodyWithBytes(262_144);

    const boundaryResponse = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: boundaryBody,
    });
    const oversizedResponse = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: executeRequestBodyWithBytes(262_145),
    });

    expect(boundaryResponse.status).toBe(200);
    expect(oversizedResponse.status).toBe(413);
    expect(businessInputs).toHaveLength(1);
  });

  it("uses four concurrent executions as the default capacity", async () => {
    const fourExecutionsStarted = deferred<void>();
    const releaseExecutions = deferred<void>();
    let executionCount = 0;
    const businessApi = await startServer(async (_request, response) => {
      executionCount += 1;
      if (executionCount === 4) fourExecutionsStarted.resolve();
      if (executionCount <= 4) await releaseExecutions.promise;
      writeJson(response, 200, { content: "Completed" });
    });
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: businessApi.url,
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();

    const admittedResponses = Array.from({ length: 4 }, () =>
      executeContentProcess(url),
    );
    await fourExecutionsStarted.promise;

    try {
      const capacityResponse = await executeContentProcess(url);
      expect(capacityResponse.status).toBe(503);
      expect(executionCount).toBe(4);
    } finally {
      releaseExecutions.resolve();
    }

    expect(
      await Promise.all(
        admittedResponses.map(async (response) => (await response).status),
      ),
    ).toEqual([200, 200, 200, 200]);
  });

  it("returns an explicitly configured listen port", () => {
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: "https://business.example",
      PORT: "4100",
    });

    expect(constructed.port).toBe(4100);
  });

  it.each(["", "0", "65536", "-1", "1.5", "not-a-number"])(
    "rejects invalid listen port %j before listening",
    (port) => {
      expect(() =>
        constructProcessingService({
          BUSINESS_API_BASE_URL: "https://business.example",
          PORT: port,
        }),
      ).toThrow("PORT must be an integer between 1 and 65535");
    },
  );

  it("applies the configured Process Runner timeout", async () => {
    const businessApi = await startServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          writeJson(response, 200, { content: "Late business response" });
        }
      }, 100);
    });
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: businessApi.url,
      BUSINESS_API_TIMEOUT_MS: "1000",
      PROCESS_TIMEOUT_MS: "20",
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();

    const response = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        process: "content-processing",
        version: "v1",
        input: { content: "Bound this request" },
      }),
    });

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: {
        code: "PROCESS_TIMEOUT",
        message: "The process exceeded its time limit",
      },
    });
  });

  it("applies the configured Business Capability timeout", async () => {
    const businessApi = await startServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          writeJson(response, 200, { content: "Late business response" });
        }
      }, 100);
    });
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: businessApi.url,
      BUSINESS_API_TIMEOUT_MS: "20",
      PROCESS_TIMEOUT_MS: "1000",
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();

    const response = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        process: "content-processing",
        version: "v1",
        input: { content: "Bound this dependency" },
      }),
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

  it("applies the configured titled-content separator", async () => {
    const businessInputs: unknown[] = [];
    const businessApi = await startServer(async (request, response) => {
      businessInputs.push(await readJson(request));
      writeJson(response, 200, { content: "Refined titled content" });
    });
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: businessApi.url,
      TITLED_CONTENT_SEPARATOR: " — ",
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();

    const response = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        process: "titled-content-processing",
        version: "v1",
        input: { title: "Release", body: "Ready" },
      }),
    });

    expect(response.status).toBe(200);
    expect(businessInputs).toEqual([{ content: "Release — Ready" }]);
    expect(await response.json()).toMatchObject({
      process: "titled-content-processing",
      version: "v1",
      status: "succeeded",
      output: {
        title: "Release",
        content: "Refined titled content",
      },
    });
  });

  it.each(["", "agents", "DIRECT"])(
    "rejects unknown content-processing mode %j before listening",
    (mode) => {
      expect(() =>
        constructProcessingService({
          BUSINESS_API_BASE_URL: "https://business.example",
          CONTENT_PROCESSING_MODE: mode,
        }),
      ).toThrow("CONTENT_PROCESSING_MODE must be direct or agent");
    },
  );

  it("keeps Agent-mode health checks isolated from external dependencies", async () => {
    const externalRequests: string[] = [];
    const externalSentinel = await startServer((request, response) => {
      externalRequests.push(request.url ?? "");
      response.writeHead(500).end();
    });
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: externalSentinel.url,
      CONTENT_PROCESSING_MODE: "agent",
      PI_PROVIDER: "openai",
      PI_MODEL: "gpt-5.6-terra",
      PI_AGENT_DIR: "/must-not-be-read/pi-agent",
      PI_SKILL_DIRECTORY: "/must-not-be-read/content-optimization",
      OPENAI_BASE_URL: `${externalSentinel.url}/v1`,
      OPENAI_API_MODE: "responses",
      OPENAI_API_KEY: "must-not-be-read",
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();

    const response = await fetch(`${url}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(externalRequests).toEqual([]);
  });

  it.each([
    { PI_PROVIDER: "openai" },
    { PI_MODEL: "gpt-5.6-terra" },
  ])("rejects an incomplete Agent model override %j", (agentEnvironment) => {
    expect(() =>
      constructProcessingService({
        BUSINESS_API_BASE_URL: "https://business.example",
        CONTENT_PROCESSING_MODE: "agent",
        ...agentEnvironment,
      }),
    ).toThrow("Pi provider and model must be configured together");
  });

  it("rejects an unknown OpenAI API mode in Agent mode", () => {
    expect(() =>
      constructProcessingService({
        BUSINESS_API_BASE_URL: "https://business.example",
        CONTENT_PROCESSING_MODE: "agent",
        OPENAI_API_MODE: "legacy-completions",
      }),
    ).toThrow("OPENAI_API_MODE must be responses or chat-completions");
  });

  it("preserves compatible-gateway validation in Agent mode", () => {
    expect(() =>
      constructProcessingService({
        BUSINESS_API_BASE_URL: "https://business.example",
        CONTENT_PROCESSING_MODE: "agent",
        OPENAI_BASE_URL: "https://gateway.example/v1",
      }),
    ).toThrow(
      "OpenAI Chat Completions mode requires PI_PROVIDER=openai and PI_MODEL",
    );
  });

  it("accepts explicit Agent overrides without contacting the provider", () => {
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: "https://business.example",
      CONTENT_PROCESSING_MODE: "agent",
      PI_PROVIDER: "openai",
      PI_MODEL: "gpt-5.6-terra",
      PI_AGENT_DIR: "/tmp/pi-agent",
      PI_SKILL_DIRECTORY: "/tmp/content-optimization",
      OPENAI_BASE_URL: "https://gateway.example/v1",
      OPENAI_API_MODE: "responses",
    });

    expect(constructed.port).toBe(3000);
  });

  it("executes direct mode while invalid Agent configuration stays inert", async () => {
    const businessInputs: unknown[] = [];
    const businessApi = await startServer(async (request, response) => {
      businessInputs.push(await readJson(request));
      writeJson(response, 200, { content: "Direct response" });
    });
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: businessApi.url,
      CONTENT_PROCESSING_MODE: "direct",
      PI_PROVIDER: "unpaired-provider",
      PI_AGENT_DIR: "/must-not-be-read/pi-agent",
      PI_SKILL_DIRECTORY: "/must-not-be-read/content-optimization",
      OPENAI_BASE_URL: "https://gateway.example/v1",
      OPENAI_API_MODE: "legacy-completions",
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();

    const response = await executeContentProcess(url);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "succeeded",
      output: { content: "Direct response" },
    });
    expect(businessInputs).toEqual([{ content: "Startup review" }]);
  });

  it("applies the configured HTTP request-body limit", async () => {
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: "https://business.example",
      HTTP_MAX_REQUEST_BODY_BYTES: "80",
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();

    const response = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        process: "content-processing",
        version: "v1",
        input: { content: "x".repeat(100) },
      }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      status: "failed",
      error: {
        code: "REQUEST_TOO_LARGE",
        message: "Request body exceeds the configured limit",
      },
    });
  });

  it("applies the configured concurrent-execution limit", async () => {
    const executionStarted = deferred<void>();
    const releaseExecution = deferred<void>();
    const businessApi = await startServer(async (_request, response) => {
      executionStarted.resolve();
      await releaseExecution.promise;
      writeJson(response, 200, { content: "Completed" });
    });
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: businessApi.url,
      MAX_CONCURRENT_EXECUTIONS: "1",
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();
    const requestBody = JSON.stringify({
      process: "content-processing",
      version: "v1",
      input: { content: "Concurrent request" },
    });

    const firstResponsePromise = fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    await executionStarted.promise;

    try {
      const secondResponse = await fetch(`${url}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });

      expect(secondResponse.status).toBe(503);
      expect(secondResponse.headers.get("retry-after")).toBe("1");
      expect(await secondResponse.json()).toEqual({
        status: "failed",
        error: { code: "SERVICE_BUSY", message: "Service is at capacity" },
      });
    } finally {
      releaseExecution.resolve();
    }

    expect((await firstResponsePromise).status).toBe(200);
  });

  it.each([undefined, "", "   "])(
    "requires a Business Capability URL for environment value %j",
    (baseUrl) => {
      expect(() =>
        constructProcessingService({ BUSINESS_API_BASE_URL: baseUrl }),
      ).toThrow("BUSINESS_API_BASE_URL is required");
    },
  );

  it.each([
    "not-a-url-with-secret-value",
    "file:///private/business-api",
    "https://user:secret-value@business.example",
  ])("rejects unsafe Business Capability URL %j without echoing it", (baseUrl) => {
    let error: unknown;
    try {
      constructProcessingService({ BUSINESS_API_BASE_URL: baseUrl });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "BUSINESS_API_BASE_URL must be a valid HTTP(S) URL without credentials",
    );
    expect((error as Error).message).not.toContain(baseUrl);
    expect((error as Error).message).not.toContain("secret-value");
  });

  it.each(["1", "65535"])("accepts listen-port boundary %j", (port) => {
    const constructed = constructProcessingService({
      BUSINESS_API_BASE_URL: "https://business.example",
      PORT: port,
    });

    expect(constructed.port).toBe(Number(port));
  });

  it.each([
    "BUSINESS_API_TIMEOUT_MS",
    "PROCESS_TIMEOUT_MS",
    "HTTP_MAX_REQUEST_BODY_BYTES",
    "MAX_CONCURRENT_EXECUTIONS",
  ])("rejects invalid positive-integer values for %s", (name) => {
    for (const value of ["", "0", "-1", "1.5", "not-a-number"]) {
      expect(() =>
        constructProcessingService({
          BUSINESS_API_BASE_URL: "https://business.example",
          [name]: value,
        }),
      ).toThrow(`${name} must be a positive integer`);
    }
  });
});

function executeContentProcess(url: string): Promise<Response> {
  return fetch(`${url}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      process: "content-processing",
      version: "v1",
      input: { content: "Startup review" },
    }),
  });
}

function executeRequestBodyWithBytes(byteLength: number): string {
  const createBody = (content: string) =>
    JSON.stringify({
      process: "content-processing",
      version: "v1",
      input: { content },
    });
  const emptyBody = createBody("");
  const contentByteLength = byteLength - Buffer.byteLength(emptyBody);
  if (contentByteLength < 1) {
    throw new Error("Requested test body is too small");
  }
  const body = createBody("x".repeat(contentByteLength));
  if (Buffer.byteLength(body) !== byteLength) {
    throw new Error("Could not construct the requested test body size");
  }
  return body;
}

function useControllableAbortTimeouts(): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), delay);
    return controller.signal;
  });
}

async function startServer(listener: RequestListener): Promise<RunningServer> {
  const server = createServer(listener);
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
    throw new Error("Expected test server to listen on an IP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
