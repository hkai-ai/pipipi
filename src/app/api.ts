/** API 配置翻译、校验、Adapter 选择和完整生产组装 */
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
    createProcessingApplication,
    type ProcessingApplication,
} from "../api/application.js";
import { createFileControlledAsyncIntake } from "../api/async-intake.js";
import {
    defaultHttpMaxRequestBodyBytes,
    defaultMaxConcurrentExecutions,
    type ProcessingHttpOptions,
} from "../api/http.js";
import { createGatewayCallerIdentityResolver } from "../api/identity.js";
import { describeProcessCatalog } from "../api/process-catalog.js";
import { createAsyncProcessRuns } from "../process-runs/index.js";
import {
    type AsyncReleaseStage,
    createPostgresAsyncReleaseReadiness,
} from "../process-runs/ops/postgres.js";
import { createPostgresProcessRunStore } from "../process-runs/store/postgres.js";
import type { ProcessRegistry } from "../process-runtime/index.js";
import { createProductionRuntime } from "./business-processes.js";
import type { StartupEnvironment } from "./config.js";
import { assertDeploymentEnvironment } from "./deployment-environment.js";
import {
    type ConstructedProcessRunObservation,
    constructProcessRunObservation,
} from "./run-observation.js";

export type { StartupEnvironment } from "./config.js";

export type ConstructedProcessingService = {
    application: ProcessingApplication;
    port: number;
};

export function constructProcessingService(
    environment: StartupEnvironment,
): ConstructedProcessingService {
    assertDeploymentEnvironment(environment, "api", {
        includeProviderCredentials: environment.NODE_ENV === "production",
    });
    const port = parsePort(environment.PORT);
    const httpConfiguration = loadHttpConfiguration(environment);
    const archive = constructProcessRunObservation(environment);
    const runtime = createProductionRuntime(environment, {
        ...(archive
            ? {
                  runRecords: archive.records,
                  additionalRunLogSinks: [archive.activities.record],
              }
            : {}),
    });
    const asyncProcessRuns = constructAsyncProcessRuns(
        environment,
        runtime.registry,
    );
    const consoleOptions = constructConsole(
        environment,
        archive,
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
                ...(consoleOptions ? { console: consoleOptions } : {}),
            },
            ...closeResourcesOption([asyncProcessRuns?.close, archive?.close]),
        }),
        port,
    };
}

/**
 * Closes every resource the service opened, even if an earlier one fails, so a
 * shutdown cannot leak a connection pool behind a failing one.
 */
function closeResourcesOption(
    closers: readonly ((() => Promise<void>) | undefined)[],
): Readonly<{ closeResources?: () => Promise<void> }> {
    const present = closers.filter(
        (close): close is () => Promise<void> => close !== undefined,
    );
    if (present.length === 0) return {};
    return {
        closeResources: async () => {
            const results = await Promise.allSettled(
                present.map((close) => close()),
            );
            const failure = results.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );
            if (failure) throw failure.reason;
        },
    };
}

/**
 * The built console ships beside the compiled server, so the default is derived
 * from this module's own location rather than a working directory. An override
 * exists for running the server from a different layout.
 */
function consoleAssetDirectory(environment: StartupEnvironment): string {
    const override = environment.CONSOLE_ASSET_DIRECTORY?.trim();
    return override && override.length > 0
        ? override
        : fileURLToPath(new URL("../console", import.meta.url));
}

function constructConsole(
    environment: StartupEnvironment,
    archive: ConstructedProcessRunObservation | undefined,
    registry: ProcessRegistry,
): NonNullable<ProcessingHttpOptions["console"]> | undefined {
    if (!parseFeatureFlag(environment.CONSOLE_ENABLED, "CONSOLE_ENABLED")) {
        return undefined;
    }
    if (!archive) {
        throw new Error(
            "PROCESS_RUN_RECORD_DIRECTORY is required when CONSOLE_ENABLED is true",
        );
    }
    const revision = parseRevision(environment.PIPIPI_REVISION);
    return Object.freeze({
        basePath: parseConsoleBasePath(environment.CONSOLE_BASE_PATH),
        ...(revision ? { revision } : {}),
        assetDirectory: consoleAssetDirectory(environment),
        records: Object.freeze({
            list: archive.archive.list,
            find: archive.archive.find,
        }),
        activities: Object.freeze({
            findByRun: archive.activities.findByRun,
        }),
        processes: describeProcessCatalog(registry),
        stats: Object.freeze({ summarise: archive.stats.summarise }),
    });
}

function parseRevision(value: string | undefined): string | undefined {
    const revision = value?.trim();
    if (!revision) return undefined;
    if (!/^[0-9a-f]{40}$/.test(revision)) {
        throw new Error("PIPIPI_REVISION must be a full lowercase commit SHA");
    }
    return revision;
}

/**
 * The console has no authentication of its own. An unguessable base path is
 * the only mitigation available when the entry gateway does not add one, so
 * the value is configurable and validated as a single safe path segment set.
 */
function parseConsoleBasePath(value: string | undefined): string {
    const candidate = value?.trim();
    if (candidate === undefined || candidate.length === 0) return "/console";
    if (
        !/^(\/[A-Za-z0-9._~-]+)+$/.test(candidate) ||
        candidate.length > 200 ||
        candidate.startsWith("/execute") ||
        candidate.startsWith("/internal/eval/execute") ||
        "/internal/eval/execute".startsWith(`${candidate}/`) ||
        candidate.startsWith("/process-runs") ||
        candidate === "/llms.txt" ||
        candidate === "/llm.txt" ||
        candidate === "/docs/api.md" ||
        candidate.startsWith("/healthz") ||
        candidate.startsWith("/readyz")
    ) {
        throw new Error(
            "CONSOLE_BASE_PATH must be a path of safe segments that does not shadow a service route",
        );
    }
    return candidate;
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
    const intake = environment.ASYNC_PROCESS_RUN_INTAKE_DISABLED_FILE
        ? createFileControlledAsyncIntake({
              disabledMarkerFile:
                  environment.ASYNC_PROCESS_RUN_INTAKE_DISABLED_FILE,
          })
        : undefined;

    return Object.freeze({
        http: Object.freeze({
            runs,
            callerIdentity,
            readiness: async () => {
                await store.ready();
                await releaseReady();
            },
            ...(intake ? { intakeOpen: intake.isOpen } : {}),
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

function parseFeatureFlag(
    value: string | undefined,
    name = "ASYNC_PROCESS_RUNS_ENABLED",
): boolean {
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    throw new Error(`${name} must be true or false`);
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
        internalEvaluationEnabled: parseFeatureFlag(
            environment.INTERNAL_EVAL_ENABLED,
            "INTERNAL_EVAL_ENABLED",
        ),
    };
}
