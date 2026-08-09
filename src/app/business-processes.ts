import { parseOpenAIApiMode } from "../processes/agent/pi.js";
import {
    createProcessRuntime,
    type ProcessRuntime,
} from "../processes/catalog.js";
import type { ContentAgent } from "../processes/content/agent.js";
import { parseBusinessApiBaseUrl } from "../processes/content/config.js";
import { HttpContentProcessingCapability } from "../processes/content/http.js";
import { PiContentAgent } from "../processes/content/pi.js";
import { createContentSkillRefs } from "../processes/content/skills.js";
import { HttpPosterRenderingCapability } from "../processes/poster/http.js";
import { PiPosterAgent } from "../processes/poster/pi.js";
import { createPosterSkillRefs } from "../processes/poster/skills.js";
import type { ProcessRetryPolicy } from "../processes/runtime/index.js";
import type { StartupEnvironment } from "./config.js";

export function createProductionRuntime(
    environment: StartupEnvironment,
): ProcessRuntime {
    const mode = parseContentMode(environment.CONTENT_PROCESSING_MODE);
    const baseUrl = parseBusinessApiBaseUrl(environment.BUSINESS_API_BASE_URL);
    const openAIApiMode = parseOpenAIApiMode(environment.OPENAI_API_MODE);
    const capability = new HttpContentProcessingCapability({
        baseUrl,
        timeoutMs: parsePositiveInteger(
            environment.BUSINESS_API_TIMEOUT_MS,
            10_000,
            "BUSINESS_API_TIMEOUT_MS",
        ),
    });
    const agent: ContentAgent | undefined =
        mode === "agent"
            ? new PiContentAgent({
                  skills: createContentSkillRefs({
                      optimizationPath: environment.PI_SKILL_DIRECTORY,
                  }),
                  provider: environment.PI_PROVIDER,
                  model: environment.PI_MODEL,
                  openAIBaseUrl: environment.OPENAI_BASE_URL,
                  openAIApiMode,
                  agentDir: environment.PI_AGENT_DIR,
              })
            : undefined;
    return createProcessRuntime({
        contentProcessing: capability,
        agent,
        poster: {
            agent: new PiPosterAgent({
                skills: createPosterSkillRefs({
                    path: environment.PI_POSTER_SKILL_DIRECTORY,
                }),
                provider: environment.PI_PROVIDER,
                model: environment.PI_MODEL,
                openAIBaseUrl: environment.OPENAI_BASE_URL,
                openAIApiMode,
                agentDir: environment.PI_AGENT_DIR,
            }),
            capability: new HttpPosterRenderingCapability({
                baseUrl,
                timeoutMs: parsePositiveInteger(
                    environment.POSTER_API_TIMEOUT_MS,
                    90_000,
                    "POSTER_API_TIMEOUT_MS",
                ),
            }),
        },
        processTimeoutMs: parsePositiveInteger(
            environment.PROCESS_TIMEOUT_MS,
            30_000,
            "PROCESS_TIMEOUT_MS",
        ),
        processes: {
            contentProcessing: {
                mode,
                retryPolicy: parseContentRetry(environment),
            },
            titledContentProcessing: {
                separator: environment.TITLED_CONTENT_SEPARATOR,
            },
        },
    });
}

function parseContentMode(value: string | undefined): "direct" | "agent" {
    if (value === undefined || value === "direct") return "direct";
    if (value === "agent") return "agent";
    throw new Error("CONTENT_PROCESSING_MODE must be direct or agent");
}

function parseContentRetry(
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
