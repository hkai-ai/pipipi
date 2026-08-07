import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createContentProcessingProcess,
  type ContentProcessCapabilities,
  type ContentProcessingCapability,
} from "./content-processing.js";
import {
  ProcessRegistry,
  ProcessRunner,
  type ProcessErrorCode,
  type ProcessRunResult,
} from "./process-runtime.js";

export type ProcessingApplication = {
  listen: (options?: {
    host?: string;
    port?: number;
  }) => Promise<{ url: string }>;
  close: () => Promise<void>;
};

export function createProcessingApplication(options: {
  contentProcessing: ContentProcessingCapability;
  processTimeoutMs?: number;
}): ProcessingApplication {
  const registry = new ProcessRegistry<ContentProcessCapabilities>([
    createContentProcessingProcess(),
  ]);
  const runner = new ProcessRunner({
    registry,
    capabilities: { contentProcessing: options.contentProcessing },
    processTimeoutMs: options.processTimeoutMs,
  });
  const server = createServer((request, response) => {
    void handleRequest(request, response, runner);
  });

  return {
    listen: async (listenOptions) => ({
      url: await listen(server, listenOptions),
    }),
    close: async () => close(server),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runner: ProcessRunner<ContentProcessCapabilities>,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/execute") {
    writeJson(response, 404, {
      status: "failed",
      error: { code: "ROUTE_NOT_FOUND", message: "Route not found" },
    });
    return;
  }

  const result = await runner.execute(await readRequestBody(request));
  writeJson(response, statusFor(result), result);
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function statusFor(result: ProcessRunResult): number {
  if (result.status === "succeeded") return 200;

  const statuses: Record<ProcessErrorCode, number> = {
    DEPENDENCY_FAILURE: 502,
    INTERNAL_ERROR: 500,
    INVALID_INPUT: 400,
    INVALID_OUTPUT: 500,
    PROCESS_NOT_FOUND: 404,
    PROCESS_TIMEOUT: 504,
  };
  return statuses[result.error.code];
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listen(
  server: Server,
  options: { host?: string; port?: number } = {},
): Promise<string> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the server to listen on an IP address");
  }
  return `http://${host}:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
