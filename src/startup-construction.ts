import { Pool } from "pg";
import {
  createProcessingApplication,
  type ProcessingApplication,
} from "./application.js";
import {
  parseOpenAIApiMode,
  PiContentOptimizationAgentRuntime,
} from "./agent-runtime.js";
import { createAsyncProcessRuns } from "./async-process-runs.js";
import {
  createBusinessProcessRuntime,
  type BusinessProcessRuntime,
} from "./business-process-executor.js";
import { createGatewayCallerIdentityResolver } from "./caller-identity.js";
import { HttpContentProcessingCapability } from "./content-processing.js";
import {
  defaultHttpMaxRequestBodyBytes,
  defaultMaxConcurrentExecutions,
  type ProcessingHttpOptions,
} from "./http-adapter.js";
import { createPostgresProcessRunStore } from "./postgres-process-run-store.js";
import type { ProcessRegistry } from "./process-runtime.js";
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
          openAIApiMode: parseOpenAIApiMode(environment.OPENAI_API_MODE),
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
      contentProcessing: { mode: contentProcessingMode },
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

  const connectionString = parsePostgresConnectionString(
    environment.DATABASE_URL,
  );
  const sharedSecret = requireConfiguration(
    environment.ASYNC_GATEWAY_SHARED_SECRET,
    "ASYNC_GATEWAY_SHARED_SECRET",
  );
  const callerIdentity = createGatewayCallerIdentityResolver({ sharedSecret });
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
  });
  const runs = createAsyncProcessRuns({ registry, store });

  return Object.freeze({
    http: Object.freeze({
      runs,
      callerIdentity,
      readiness: store.ready,
      retryAfterSeconds,
    }),
    close: () => pool.end(),
  });
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
    throw new Error(`${name} is required when Async Process Runs are enabled`);
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
    throw new Error("DATABASE_URL is required when Async Process Runs are enabled");
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
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
  return candidate;
}

function requireConfiguration(
  value: string | undefined,
  name: string,
): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when Async Process Runs are enabled`);
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
