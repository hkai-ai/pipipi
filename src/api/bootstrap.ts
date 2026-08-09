import { Pool } from "pg";
import { createAsyncProcessRuns } from "../process-runs/index.js";
import {
    type AsyncReleaseStage,
    createPostgresAsyncReleaseReadiness,
} from "../process-runs/ops/index.js";
import { createPostgresProcessRunStore } from "../process-runs/store/postgres.js";
import {
    PiContentOptimizationAgentRuntime,
    parseOpenAIApiMode,
} from "../processes/agent.js";
import {
    type BusinessProcessRuntime,
    createBusinessProcessRuntime,
} from "../processes/catalog.js";
import { HttpContentProcessingCapability } from "../processes/content.js";
import { parseBusinessApiBaseUrl } from "../processes/content-config.js";
import type {
    ProcessRegistry,
    ProcessRetryPolicy,
} from "../processes/runtime.js";
import {
    createProcessingApplication,
    type ProcessingApplication,
} from "./application.js";
import {
    defaultHttpMaxRequestBodyBytes,
    defaultMaxConcurrentExecutions,
    type ProcessingHttpOptions,
} from "./http.js";
import { createGatewayCallerIdentityResolver } from "./identity.js";

export type StartupEnvironment = Readonly<Record<string, string | undefined>>;

export type ConstructedProcessingService = {
    application: ProcessingApplication;
    port: number;
};

export function constructProcessingService(
    environment: StartupEnvironment,
): ConstructedProcessingService {
    const port = parsePort(environment.PORT);
    const httpConfiguration = loadHttpConfiguration(environment);
    const runtime = constructBusinessProcessRuntime(environment);
    const asyncProcessRuns = constructAsyncProcessRuns(
        environment,
        runtime.registry,
    );

    return {
        application: createProcessingApplication({
            executor: runtime.executor,
            http: {
                ...httpConfiguration,
                ...(asyncProcessRuns
                    ? { asyncProcessRuns: asyncProcessRuns.http }
                    : {}),
            },
            ...(asyncProcessRuns
                ? { closeResources: asyncProcessRuns.close }
                : {}),
        }),
        port,
    };
}

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

function constructAsyncProcessRuns(
    environment: StartupEnvironment,
    registry: ProcessRegistry,
):
    | Readonly<{
          http: NonNullable<ProcessingHttpOptions["asyncProcessRuns"]>;
          close: () => Promise<void>;
      }>
    | undefined {
    if (!parseFeatureFlag(environment.ASYNC_PROCESS_RUNS_ENABLED)) {
        return undefined;
    }

    const releaseStage = parseAsyncReleaseStage(
        environment.ASYNC_RELEASE_STAGE,
    );

    const connectionString = parsePostgresConnectionString(
        environment.DATABASE_URL,
    );
    const sharedSecret = requireConfiguration(
        environment.ASYNC_GATEWAY_SHARED_SECRET,
        "ASYNC_GATEWAY_SHARED_SECRET",
    );
    const callerIdentity = createGatewayCallerIdentityResolver({
        sharedSecret,
    });
    const retention = {
        acceptedInputMs: parseRequiredPositiveInteger(
            environment.PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS,
            "PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS",
        ),
        resultMs: parseRequiredPositiveInteger(
            environment.PROCESS_RUN_RESULT_RETENTION_MS,
            "PROCESS_RUN_RESULT_RETENTION_MS",
        ),
        metadataMs: parseRequiredPositiveInteger(
            environment.PROCESS_RUN_METADATA_RETENTION_MS,
            "PROCESS_RUN_METADATA_RETENTION_MS",
        ),
    };
    const poolMax = parsePositiveInteger(
        environment.ASYNC_POSTGRES_POOL_MAX,
        10,
        "ASYNC_POSTGRES_POOL_MAX",
    );
    const connectionTimeoutMillis = parsePositiveInteger(
        environment.ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS,
        5_000,
        "ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS",
    );
    const claimLeaseMs = parsePositiveInteger(
        environment.PROCESS_RUN_CLAIM_LEASE_MS,
        60_000,
        "PROCESS_RUN_CLAIM_LEASE_MS",
    );
    const retryAfterSeconds = parsePositiveInteger(
        environment.ASYNC_RETRY_AFTER_SECONDS,
        2,
        "ASYNC_RETRY_AFTER_SECONDS",
    );
    const globalBacklogLimit = parseRequiredPositiveInteger(
        environment.ASYNC_GLOBAL_BACKLOG_LIMIT,
        "ASYNC_GLOBAL_BACKLOG_LIMIT",
    );
    const callerBacklogLimit = parseRequiredPositiveInteger(
        environment.ASYNC_CALLER_BACKLOG_LIMIT,
        "ASYNC_CALLER_BACKLOG_LIMIT",
    );
    if (callerBacklogLimit > globalBacklogLimit) {
        throw new Error(
            "ASYNC_CALLER_BACKLOG_LIMIT must not exceed ASYNC_GLOBAL_BACKLOG_LIMIT",
        );
    }
    const backlogRetryAfterSeconds = parseRequiredPositiveInteger(
        environment.ASYNC_BACKLOG_RETRY_AFTER_SECONDS,
        "ASYNC_BACKLOG_RETRY_AFTER_SECONDS",
    );
    const releaseReadiness = {
        stuckRunAgeMs: parsePositiveInteger(
            environment.ASYNC_STUCK_RUN_AGE_MS,
            300_000,
            "ASYNC_STUCK_RUN_AGE_MS",
        ),
        maximumStuckRuns: parseNonNegativeInteger(
            environment.ASYNC_MAX_STUCK_RUNS,
            0,
            "ASYNC_MAX_STUCK_RUNS",
        ),
        maximumOutboxLagMs: parsePositiveInteger(
            environment.ASYNC_MAX_OUTBOX_LAG_MS,
            60_000,
            "ASYNC_MAX_OUTBOX_LAG_MS",
        ),
        recoveryMaxAgeMs: parsePositiveInteger(
            environment.ASYNC_RECOVERY_MAX_AGE_MS,
            86_400_000,
            "ASYNC_RECOVERY_MAX_AGE_MS",
        ),
    };
    const pool = new Pool({
        connectionString,
        max: poolMax,
        connectionTimeoutMillis,
        application_name: "pipipi-process-api",
    });
    pool.on("error", () => {
        console.error(
            JSON.stringify({
                event: "postgres_pool_error",
                timestamp: new Date().toISOString(),
            }),
        );
    });
    const store = createPostgresProcessRunStore({
        pool,
        retention,
        claimLeaseMs,
        admission: {
            globalBacklogLimit,
            callerBacklogLimit,
            retryAfterSeconds: backlogRetryAfterSeconds,
        },
    });
    const runs = createAsyncProcessRuns({ registry, store });
    const releaseReady = createPostgresAsyncReleaseReadiness({
        pool,
        stage: releaseStage,
        globalBacklogLimit,
        ...releaseReadiness,
    });

    return Object.freeze({
        http: Object.freeze({
            runs,
            callerIdentity,
            readiness: async () => {
                await store.ready();
                await releaseReady();
            },
            retryAfterSeconds,
        }),
        close: () => pool.end(),
    });
}

function parseAsyncReleaseStage(value: string | undefined): AsyncReleaseStage {
    if (value === undefined) {
        throw new Error(
            "ASYNC_RELEASE_STAGE is required when Async Process Runs are enabled",
        );
    }
    if (value === "internal" || value === "canary" || value === "production") {
        return value;
    }
    throw new Error(
        "ASYNC_RELEASE_STAGE must be internal, canary, or production",
    );
}

function parseNonNegativeInteger(
    value: string | undefined,
    fallback: number,
    name: string,
): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return parsed;
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

function parseRequiredPositiveInteger(
    value: string | undefined,
    name: string,
): number {
    if (value === undefined) {
        throw new Error(
            `${name} is required when Async Process Runs are enabled`,
        );
    }
    return parsePositiveInteger(value, 1, name);
}

function parseFeatureFlag(value: string | undefined): boolean {
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    throw new Error("ASYNC_PROCESS_RUNS_ENABLED must be true or false");
}

function parsePostgresConnectionString(value: string | undefined): string {
    const candidate = value?.trim();
    if (!candidate) {
        throw new Error(
            "DATABASE_URL is required when Async Process Runs are enabled",
        );
    }
    try {
        const url = new URL(candidate);
        if (
            (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
            url.hostname.length === 0 ||
            url.pathname.length <= 1
        ) {
            throw new Error();
        }
    } catch {
        throw new Error(
            "DATABASE_URL must be a valid PostgreSQL connection URL",
        );
    }
    return candidate;
}

function requireConfiguration(value: string | undefined, name: string): string {
    if (value === undefined || value.length === 0) {
        throw new Error(
            `${name} is required when Async Process Runs are enabled`,
        );
    }
    return value;
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
