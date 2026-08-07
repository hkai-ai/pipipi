import { createProcessingApplication } from "./application.js";
import {
  parseOpenAIApiMode,
  PiContentOptimizationAgentRuntime,
} from "./agent-runtime.js";
import { HttpContentProcessingCapability } from "./content-processing.js";
import { loadHttpConfiguration } from "./http-config.js";
import { parseBusinessApiBaseUrl } from "./service-config.js";

const businessApiBaseUrl = parseBusinessApiBaseUrl(
  process.env.BUSINESS_API_BASE_URL,
);

const port = parsePort(process.env.PORT);
const http = loadHttpConfiguration(process.env);
const contentProcessingMode = parseContentProcessingMode(
  process.env.CONTENT_PROCESSING_MODE,
);
const agentRuntime =
  contentProcessingMode === "agent"
    ? new PiContentOptimizationAgentRuntime({
        provider: process.env.PI_PROVIDER,
        model: process.env.PI_MODEL,
        openAIBaseUrl: process.env.OPENAI_BASE_URL,
        openAIApiMode: parseOpenAIApiMode(process.env.OPENAI_API_MODE),
        agentDir: process.env.PI_AGENT_DIR,
        skillDirectory: process.env.PI_SKILL_DIRECTORY,
      })
    : undefined;
const application = createProcessingApplication({
  contentProcessing: new HttpContentProcessingCapability({
    baseUrl: businessApiBaseUrl,
    timeoutMs: parseTimeout(process.env.BUSINESS_API_TIMEOUT_MS, 10_000),
  }),
  agentRuntime,
  http,
  processTimeoutMs: parseTimeout(process.env.PROCESS_TIMEOUT_MS, 30_000),
  processes: {
    contentProcessing: { mode: contentProcessingMode },
    titledContentProcessing: {
      separator: process.env.TITLED_CONTENT_SEPARATOR,
    },
  },
});
const { url } = await application.listen({ host: "0.0.0.0", port });

console.log(
  JSON.stringify({
    event: "service_started",
    timestamp: new Date().toISOString(),
    url,
  }),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void application.close().then(() => {
      process.exitCode = 0;
    });
  });
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error("Timeout values must be positive integers");
  }
  return timeout;
}

function parseContentProcessingMode(
  value: string | undefined,
): "direct" | "agent" {
  if (value === undefined || value === "direct") return "direct";
  if (value === "agent") return "agent";
  throw new Error("CONTENT_PROCESSING_MODE must be direct or agent");
}
