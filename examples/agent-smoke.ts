import { parseOpenAIApiMode } from "../src/agent-runtime/pi.js";
import { createProcessingApplication } from "../src/api/application.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import { PiContentAgent } from "../src/processes/content/agent.pi.js";
import { HttpContentProcessingCapability } from "../src/processes/content/capability.http.js";
import type { ContentProcessingCapability } from "../src/processes/content/capability.js";
import { parseBusinessApiBaseUrl } from "../src/processes/content/config.js";
import { createContentSkillRefs } from "../src/processes/content/skills.js";

const businessApiBaseUrl = parseBusinessApiBaseUrl(
    process.env.BUSINESS_API_BASE_URL,
);
const remoteContentProcessing = new HttpContentProcessingCapability({
    baseUrl: businessApiBaseUrl,
});
const capabilityCalls: Array<{ input: string; result: string }> = [];
const trackedContentProcessing: ContentProcessingCapability = {
    process: async (input, options) => {
        const result = await remoteContentProcessing.process(input, options);
        capabilityCalls.push({ input: input.content, result: result.content });
        return result;
    },
};

const executor = createProcessExecutor({
    contentProcessing: trackedContentProcessing,
    agent: new PiContentAgent({
        skills: createContentSkillRefs({
            optimizationPath: process.env.PI_SKILL_DIRECTORY,
        }),
        provider: process.env.PI_PROVIDER,
        model: process.env.PI_MODEL,
        openAIBaseUrl: process.env.OPENAI_BASE_URL,
        openAIApiMode: parseOpenAIApiMode(process.env.OPENAI_API_MODE),
        agentDir: process.env.PI_AGENT_DIR,
    }),
    processTimeoutMs: 120_000,
    processes: { contentProcessing: { mode: "agent" } },
});
const application = createProcessingApplication({ executor });
const configuredContent = process.env.AGENT_SMOKE_CONTENT;
const content =
    configuredContent ??
    "On 2026-08-09, Alice approved 3 items at https://example.com/release.";

const { url } = await application.listen();
try {
    const response = await fetch(`${url}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            process: "content-processing",
            version: "v1",
            input: { content },
        }),
    });
    const result: unknown = await response.json();
    if (!response.ok || !isSuccessfulExecution(result)) {
        throw new Error(
            `Agent smoke execution failed with HTTP ${response.status} (${safeErrorCode(result)})`,
        );
    }
    if (capabilityCalls.length !== 1) {
        throw new Error(
            "Agent smoke must call the Business Capability exactly once",
        );
    }
    if (result.output.content !== capabilityCalls[0].result) {
        throw new Error("Agent smoke output did not come from the Tool result");
    }
    if (!configuredContent) {
        const protectedLiterals = [
            "2026-08-09",
            "Alice",
            "3",
            "https://example.com/release",
        ];
        if (
            protectedLiterals.some(
                (literal) => !capabilityCalls[0].input.includes(literal),
            )
        ) {
            throw new Error(
                "Agent smoke Tool input did not preserve protected content",
            );
        }
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
