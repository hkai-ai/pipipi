import { createProcessingApplication } from "../src/api/application.js";
import { createBusinessProcessExecutor } from "../src/processes/catalog.js";
import {
  parseOpenAIApiMode,
  PiContentOptimizationAgentRuntime,
} from "../src/processes/agent.js";
import {
  HttpContentProcessingCapability,
  type ContentProcessingCapability,
} from "../src/processes/content.js";
import { parseBusinessApiBaseUrl } from "../src/processes/content-config.js";

const businessApiBaseUrl = parseBusinessApiBaseUrl(
  process.env.BUSINESS_API_BASE_URL,
);
const remoteContentProcessing = new HttpContentProcessingCapability({
  baseUrl: businessApiBaseUrl,
});
const capabilityCalls: string[] = [];
const trackedContentProcessing: ContentProcessingCapability = {
  process: async (input, options) => {
    capabilityCalls.push(input.content);
    return remoteContentProcessing.process(input, options);
  },
};

const executor = createBusinessProcessExecutor({
  contentProcessing: trackedContentProcessing,
  agentRuntime: new PiContentOptimizationAgentRuntime({
    provider: process.env.PI_PROVIDER,
    model: process.env.PI_MODEL,
    openAIBaseUrl: process.env.OPENAI_BASE_URL,
    openAIApiMode: parseOpenAIApiMode(process.env.OPENAI_API_MODE),
    agentDir: process.env.PI_AGENT_DIR,
    skillDirectory: process.env.PI_SKILL_DIRECTORY,
  }),
  processTimeoutMs: 120_000,
  processes: { contentProcessing: { mode: "agent" } },
});
const application = createProcessingApplication({ executor });

const { url } = await application.listen();
try {
  const response = await fetch(`${url}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      process: "content-processing",
      version: "v1",
      input: {
        content:
          process.env.AGENT_SMOKE_CONTENT ??
          "Make this controlled release message clear and concise",
      },
    }),
  });
  const result: unknown = await response.json();
  if (!response.ok || !isSuccessfulExecution(result)) {
    throw new Error(
      `Agent smoke execution failed with HTTP ${response.status} (${safeErrorCode(result)})`,
    );
  }
  if (capabilityCalls.length === 0) {
    throw new Error(
      "Agent smoke completed without calling the Business Capability",
    );
  }
  console.log(
    JSON.stringify({
      event: "agent_smoke_completed",
      runId: result.runId,
      process: result.process,
      version: result.version,
      status: result.status,
      businessCapabilityCalls: capabilityCalls.length,
    }),
  );
} finally {
  await application.close();
}

function isSuccessfulExecution(value: unknown): value is {
  runId: string;
  process: "content-processing";
  version: "v1";
  status: "succeeded";
  output: { content: string };
} {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    value.process === "content-processing" &&
    value.version === "v1" &&
    value.status === "succeeded" &&
    isRecord(value.output) &&
    typeof value.output.content === "string" &&
    value.output.content.trim().length > 0
  );
}

function safeErrorCode(value: unknown): string {
  return isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string"
    ? value.error.code
    : "UNKNOWN";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
