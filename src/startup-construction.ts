import {
  createProcessingApplication,
  type ProcessingApplication,
} from "./application.js";
import {
  parseOpenAIApiMode,
  PiContentOptimizationAgentRuntime,
} from "./agent-runtime.js";
import { createBusinessProcessExecutor } from "./business-process-executor.js";
import { HttpContentProcessingCapability } from "./content-processing.js";
import {
  defaultHttpMaxRequestBodyBytes,
  defaultMaxConcurrentExecutions,
  type ProcessingHttpOptions,
} from "./http-adapter.js";
import { parseBusinessApiBaseUrl } from "./service-config.js";

export type StartupEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ConstructedProcessingService = {
  application: ProcessingApplication;
  port: number;
};

export function constructProcessingService(
  environment: StartupEnvironment,
): ConstructedProcessingService {
  const contentProcessingMode = parseContentProcessingMode(
    environment.CONTENT_PROCESSING_MODE,
  );
  const contentProcessing = new HttpContentProcessingCapability({
    baseUrl: parseBusinessApiBaseUrl(environment.BUSINESS_API_BASE_URL),
    timeoutMs: parsePositiveInteger(
      environment.BUSINESS_API_TIMEOUT_MS,
      10_000,
      "BUSINESS_API_TIMEOUT_MS",
    ),
  });
  const agentRuntime =
    contentProcessingMode === "agent"
      ? new PiContentOptimizationAgentRuntime({
          provider: environment.PI_PROVIDER,
          model: environment.PI_MODEL,
          openAIBaseUrl: environment.OPENAI_BASE_URL,
          openAIApiMode: parseOpenAIApiMode(environment.OPENAI_API_MODE),
          agentDir: environment.PI_AGENT_DIR,
          skillDirectory: environment.PI_SKILL_DIRECTORY,
        })
      : undefined;
  const executor = createBusinessProcessExecutor({
    contentProcessing,
    agentRuntime,
    processTimeoutMs: parsePositiveInteger(
      environment.PROCESS_TIMEOUT_MS,
      30_000,
      "PROCESS_TIMEOUT_MS",
    ),
    processes: {
      contentProcessing: { mode: contentProcessingMode },
      titledContentProcessing: {
        separator: environment.TITLED_CONTENT_SEPARATOR,
      },
    },
  });

  return {
    application: createProcessingApplication({
      executor,
      http: loadHttpConfiguration(environment),
    }),
    port: parsePort(environment.PORT),
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function loadHttpConfiguration(
  environment: StartupEnvironment,
): ProcessingHttpOptions {
  return {
    maxRequestBodyBytes: parsePositiveInteger(
      environment.HTTP_MAX_REQUEST_BODY_BYTES,
      defaultHttpMaxRequestBodyBytes,
      "HTTP_MAX_REQUEST_BODY_BYTES",
    ),
    maxConcurrentExecutions: parsePositiveInteger(
      environment.MAX_CONCURRENT_EXECUTIONS,
      defaultMaxConcurrentExecutions,
      "MAX_CONCURRENT_EXECUTIONS",
    ),
  };
}

function parseContentProcessingMode(
  value: string | undefined,
): "direct" | "agent" {
  if (value === undefined || value === "direct") return "direct";
  if (value === "agent") return "agent";
  throw new Error("CONTENT_PROCESSING_MODE must be direct or agent");
}
