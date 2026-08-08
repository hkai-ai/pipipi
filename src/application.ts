import {
  createServer,
  type Server,
} from "node:http";
import {
  createContentProcessingProcess,
  type ContentProcessCapabilities,
  type ContentProcessingProcessConfig,
} from "./content-processing.js";
import type { ContentOptimizationAgentRuntime } from "./agent-runtime.js";
import type { ContentProcessingCapability } from "./business-capabilities.js";
import {
  ProcessRegistry,
  ProcessRunner,
} from "./process-runtime.js";
import type { ProcessRunRecords } from "./process-run-records.js";
import {
  createProcessingRequestListener,
  type ProcessingHttpOptions,
} from "./http-adapter.js";
import {
  createTitledContentProcessingProcess,
  type TitledContentProcessingConfig,
} from "./titled-content-processing.js";

export type ProcessingApplication = {
  listen: (options?: {
    host?: string;
    port?: number;
  }) => Promise<{ url: string }>;
  close: () => Promise<void>;
};

export type ProcessingApplicationOptions = {
  contentProcessing: ContentProcessingCapability;
  agentRuntime?: ContentOptimizationAgentRuntime;
  processTimeoutMs?: number;
  runRecords?: ProcessRunRecords;
  http?: ProcessingHttpOptions;
  processes?: {
    contentProcessing?: ContentProcessingProcessConfig;
    titledContentProcessing?: TitledContentProcessingConfig;
  };
};

export function createProcessingApplication(
  options: ProcessingApplicationOptions,
): ProcessingApplication {
  const contentProcessingConfig = options.processes?.contentProcessing;
  if (contentProcessingConfig?.mode === "agent" && !options.agentRuntime) {
    throw new Error("Agent Runtime is required when Agent mode is enabled");
  }

  const registry = new ProcessRegistry<ContentProcessCapabilities>([
    createContentProcessingProcess(contentProcessingConfig),
    createTitledContentProcessingProcess(
      options.processes?.titledContentProcessing,
    ),
  ]);
  const runner = new ProcessRunner<ContentProcessCapabilities>({
    registry,
    capabilities: {
      contentProcessing: options.contentProcessing,
      agentRuntime: options.agentRuntime,
    },
    processTimeoutMs: options.processTimeoutMs,
    runRecords: options.runRecords,
  });
  const server = createServer(
    createProcessingRequestListener(runner, options.http),
  );

  return {
    listen: async (listenOptions) => ({
      url: await listen(server, listenOptions),
    }),
    close: async () => close(server),
  };
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
