import {
    type BusinessProcessRuntime,
    createBusinessProcessRuntime,
} from "../processes/catalog.js";
import {
    PiContentOptimizationAgentRuntime,
    parseOpenAIApiMode,
} from "../processes/content/agent.js";
import { parseBusinessApiBaseUrl } from "../processes/content/config.js";
import { HttpContentProcessingCapability } from "../processes/content/http.js";
import type { ProcessRetryPolicy } from "../processes/runtime/index.js";
import type { StartupEnvironment } from "./config.js";

export function constructBusinessProcessRuntime(
    environment: StartupEnvironment,
): BusinessProcessRuntime {
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
                  openAIApiMode: parseOpenAIApiMode(
                      environment.OPENAI_API_MODE,
                  ),
                  agentDir: environment.PI_AGENT_DIR,
                  skillDirectory: environment.PI_SKILL_DIRECTORY,
              })
            : undefined;
    return createBusinessProcessRuntime({
        contentProcessing,
        agentRuntime,
        processTimeoutMs: parsePositiveInteger(
            environment.PROCESS_TIMEOUT_MS,
            30_000,
            "PROCESS_TIMEOUT_MS",
        ),
        processes: {
            contentProcessing: {
                mode: contentProcessingMode,
                retryPolicy: parseContentProcessingRetryPolicy(environment),
            },
            titledContentProcessing: {
                separator: environment.TITLED_CONTENT_SEPARATOR,
            },
        },
    });
}

function parseContentProcessingMode(
    value: string | undefined,
): "direct" | "agent" {
    if (value === undefined || value === "direct") return "direct";
    if (value === "agent") return "agent";
    throw new Error("CONTENT_PROCESSING_MODE must be direct or agent");
}

function parseContentProcessingRetryPolicy(
    environment: StartupEnvironment,
): ProcessRetryPolicy {
    const maximumAttempts = parsePositiveInteger(
        environment.CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS,
        1,
        "CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS",
    );
    if (maximumAttempts > 5) {
        throw new Error(
            "CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS must not exceed 5",
        );
    }
    return Object.freeze({
        maximumAttempts,
        retryableErrorCodes: Object.freeze(
            maximumAttempts > 1 ? (["DEPENDENCY_FAILURE"] as const) : [],
        ),
        backoff: Object.freeze({
            initialDelayMs: parsePositiveInteger(
                environment.CONTENT_PROCESSING_RETRY_INITIAL_DELAY_MS,
                1_000,
                "CONTENT_PROCESSING_RETRY_INITIAL_DELAY_MS",
            ),
            maximumDelayMs: parsePositiveInteger(
                environment.CONTENT_PROCESSING_RETRY_MAX_DELAY_MS,
                30_000,
                "CONTENT_PROCESSING_RETRY_MAX_DELAY_MS",
            ),
        }),
    });
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
