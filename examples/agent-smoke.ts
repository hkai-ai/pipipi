import { createProcessingApplication } from "../src/application.js";
import { PiCodingAgentRuntime } from "../src/agent-runtime.js";
import { HttpContentProcessingCapability } from "../src/content-processing.js";

const businessApiBaseUrl = process.env.BUSINESS_API_BASE_URL;
if (!businessApiBaseUrl) {
  throw new Error("BUSINESS_API_BASE_URL is required for the Agent smoke test");
}

const application = createProcessingApplication({
  contentProcessing: new HttpContentProcessingCapability({
    baseUrl: businessApiBaseUrl,
  }),
  agentRuntime: new PiCodingAgentRuntime({
    provider: process.env.PI_PROVIDER,
    model: process.env.PI_MODEL,
    agentDir: process.env.PI_AGENT_DIR,
    skillDirectory: process.env.PI_SKILL_DIRECTORY,
  }),
  processTimeoutMs: 120_000,
  processes: { contentProcessing: { mode: "agent" } },
});

const { url } = await application.listen();
try {
  const response = await fetch(`${url}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      process: "content-processing",
      version: "v1",
      input: { content: "Make this launch message clear and concise" },
    }),
  });
  const result: unknown = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok) process.exitCode = 1;
} finally {
  await application.close();
}
