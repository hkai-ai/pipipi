/** production Business Process Runtime 与 catalog 依赖组装 */
import { parseOpenAIApiMode } from "../agent-runtime/pi.js";
import type { SkillRef } from "../agent-runtime/skills.js";
import {
    combineProcessRunLogSinks,
    type ProcessRetryPolicy,
    type ProcessRunLogSink,
} from "../process-runtime/index.js";
import type { ProcessRunRecords } from "../process-runtime/records.js";
import {
    createProcessRuntime,
    type ProcessRuntime,
} from "../processes/catalog.js";
import type { ContentAgent } from "../processes/content/agent.js";
import { PiContentAgent } from "../processes/content/agent.pi.js";
import { HttpContentProcessingCapability } from "../processes/content/capability.http.js";
import { parseBusinessApiBaseUrl } from "../processes/content/config.js";
import { PiCrtAgent } from "../processes/crt/agent.pi.js";
import { HttpCrtRenderingCapability } from "../processes/crt/capability.http.js";
import {
    PiNewsImageAgent,
    type PiNewsImageAgentOptions,
} from "../processes/news-image/agent.pi.js";
import { HttpNewsImageRenderingCapability } from "../processes/news-image/capability.http.js";
import { PiPosterAgent } from "../processes/poster/agent.pi.js";
import { HttpPosterRenderingCapability } from "../processes/poster/capability.http.js";
import { createPinoProcessRunLogSink } from "../run-observation/pino.js";
import { parsePositiveInteger, type StartupEnvironment } from "./config.js";
import { createProductionSkillBindings } from "./runtime-skills.js";

/** Pi model selection shared by every Agent-backed production Process. */
type PiAgentConfig = Pick<
    PiNewsImageAgentOptions,
    "provider" | "model" | "openAIBaseUrl" | "openAIApiMode" | "agentDir"
>;

export function createProductionRuntime(
    environment: StartupEnvironment,
    options: {
        runLogSink?: ProcessRunLogSink;
        /**
         * Extra destinations for the same activity records, composed with the
         * Pino Sink rather than replacing it. Persisting activity records must
         * not change what operators already read from stdout.
         */
        additionalRunLogSinks?: readonly ProcessRunLogSink[];
        runRecords?: ProcessRunRecords;
    } = {},
): ProcessRuntime {
    const baseRunLogSink =
        options.runLogSink ??
        createPinoProcessRunLogSink({
            level: environment.PROCESS_RUN_LOG_LEVEL,
        });
    const runLogSink = options.additionalRunLogSinks?.length
        ? combineProcessRunLogSinks(
              baseRunLogSink,
              ...options.additionalRunLogSinks,
          )
        : baseRunLogSink;
    const mode = parseContentMode(environment.CONTENT_PROCESSING_MODE);
    const baseUrl = parseBusinessApiBaseUrl(environment.BUSINESS_API_BASE_URL);
    const crtBaseUrl = parseBusinessApiBaseUrl(
        environment.CRT_BUSINESS_API_BASE_URL ??
            environment.BUSINESS_API_BASE_URL,
    );
    const pi: PiAgentConfig = {
        provider: environment.PI_PROVIDER,
        model: environment.PI_MODEL,
        openAIBaseUrl: environment.OPENAI_BASE_URL,
        openAIApiMode: parseOpenAIApiMode(environment.OPENAI_API_MODE),
        agentDir: environment.PI_AGENT_DIR,
    };
    const skills = createProductionSkillBindings(environment);
    const integer = (name: string, fallback: number) =>
        parsePositiveInteger(environment[name], fallback, name);
    const newsImage = (
        style: PiNewsImageAgentOptions["style"],
        styleSkills: readonly SkillRef[],
    ) => ({
        agent: new PiNewsImageAgent({ style, skills: styleSkills, ...pi }),
        capability: new HttpNewsImageRenderingCapability({
            baseUrl: crtBaseUrl,
            timeoutMs: integer("NEWS_IMAGE_API_TIMEOUT_MS", 180_000),
        }),
    });

    const capability = new HttpContentProcessingCapability({
        baseUrl,
        timeoutMs: integer("BUSINESS_API_TIMEOUT_MS", 10_000),
    });
    const agent: ContentAgent | undefined =
        mode === "agent"
            ? new PiContentAgent({ skills: skills.content, ...pi })
            : undefined;
    return createProcessRuntime({
        contentProcessing: capability,
        agent,
        poster: {
            agent: new PiPosterAgent({ skills: skills.poster, ...pi }),
            capability: new HttpPosterRenderingCapability({
                baseUrl,
                timeoutMs: integer("POSTER_API_TIMEOUT_MS", 90_000),
            }),
        },
        crt: {
            agent: new PiCrtAgent({ skills: skills.crt, ...pi }),
            capability: new HttpCrtRenderingCapability({
                baseUrl: crtBaseUrl,
                timeoutMs: integer("CRT_API_TIMEOUT_MS", 180_000),
            }),
        },
        paleWatercolor: newsImage("pale-watercolor", skills.paleWatercolor),
        rawHumanism: newsImage("raw-humanism", skills.rawHumanism),
        narrativeMonument: newsImage(
            "narrative-monument",
            skills.narrativeMonument,
        ),
        processTimeoutMs: integer("PROCESS_TIMEOUT_MS", 30_000),
        runLogSink,
        ...(options.runRecords ? { runRecords: options.runRecords } : {}),
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
    const integer = (name: string, fallback: number) =>
        parsePositiveInteger(environment[name], fallback, name);
    const maximumAttempts = integer("CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS", 1);
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
            initialDelayMs: integer(
                "CONTENT_PROCESSING_RETRY_INITIAL_DELAY_MS",
                1_000,
            ),
            maximumDelayMs: integer(
                "CONTENT_PROCESSING_RETRY_MAX_DELAY_MS",
                30_000,
            ),
        }),
    });
}
