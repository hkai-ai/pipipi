/** content-processing/v1 的生产装配：按 CONTENT_PROCESSING_MODE 选择 Direct 或 Pi Agent，并解析重试策略 */
import type { ProcessRetryPolicy } from "../../process-runtime/index.js";
import {
    defineProductionProcess,
    type ProductionContext,
    type ProductionEnvironment,
} from "../production.js";
import { PiContentAgent } from "./agent.pi.js";
import { HttpContentProcessingCapability } from "./capability.http.js";
import { parseBusinessApiBaseUrl } from "./config.js";
import { createContentRegistration } from "./registration.js";
import { createContentSkillRefs } from "./skills.js";

export const contentProduction = defineProductionProcess({
    id: "content-processing",
    environment: [
        "PI_SKILL_DIRECTORY",
        "CONTENT_PROCESSING_MODE",
        "BUSINESS_API_BASE_URL",
        "BUSINESS_API_TIMEOUT_MS",
        "CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS",
        "CONTENT_PROCESSING_RETRY_INITIAL_DELAY_MS",
        "CONTENT_PROCESSING_RETRY_MAX_DELAY_MS",
    ],
    installedSkills: (environment) =>
        createContentSkillRefs({
            optimizationPath: environment.PI_SKILL_DIRECTORY,
        }),
    build: ({ environment, pi, skills, positiveInteger }) => {
        const mode = parseContentMode(environment.CONTENT_PROCESSING_MODE);
        return createContentRegistration({
            capability: createProductionContentProcessingCapability(
                environment,
                positiveInteger,
            ),
            agent:
                mode === "agent"
                    ? new PiContentAgent({ skills, ...pi })
                    : undefined,
            mode,
            retryPolicy: parseContentRetry(positiveInteger),
        });
    },
});

/** The owned Business API Capability that text Processes share. */
export function createProductionContentProcessingCapability(
    environment: ProductionEnvironment,
    positiveInteger: ProductionContext["positiveInteger"],
): HttpContentProcessingCapability {
    return new HttpContentProcessingCapability({
        baseUrl: parseBusinessApiBaseUrl(environment.BUSINESS_API_BASE_URL),
        timeoutMs: positiveInteger("BUSINESS_API_TIMEOUT_MS", 10_000),
    });
}

function parseContentMode(value: string | undefined): "direct" | "agent" {
    if (value === undefined || value === "direct") return "direct";
    if (value === "agent") return "agent";
    throw new Error("CONTENT_PROCESSING_MODE must be direct or agent");
}

function parseContentRetry(
    positiveInteger: ProductionContext["positiveInteger"],
): ProcessRetryPolicy {
    const maximumAttempts = positiveInteger(
        "CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS",
        1,
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
            initialDelayMs: positiveInteger(
                "CONTENT_PROCESSING_RETRY_INITIAL_DELAY_MS",
                1_000,
            ),
            maximumDelayMs: positiveInteger(
                "CONTENT_PROCESSING_RETRY_MAX_DELAY_MS",
                30_000,
            ),
        }),
    });
}
