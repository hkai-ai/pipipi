import { Pool } from "pg";
import { writeAsyncOperationalLog } from "./async-operational-logging.js";
import {
  createBullMqWebhookWorker,
  createBullMqWebhookWorkQueue,
} from "./bullmq-webhook-work-queue.js";
import { createWebhookOutboxDispatcher } from "./outbox-dispatcher.js";
import { createPostgresWebhookDeliveryStore } from "./postgres-webhook-delivery-store.js";
import { createPostgresWebhookOutbox } from "./postgres-webhook-outbox.js";
import {
  createRuntimeRoleApplication,
  type RuntimeRoleApplication,
} from "./runtime-role-application.js";
import type { StartupEnvironment } from "./startup-construction.js";
import {
  createStandardWebhookHttpSender,
  createWebhookDeliveryWorker,
} from "./webhook-delivery.js";
import { createWebhookWorkerRuntime } from "./webhook-worker-runtime.js";
import { createWebhookSecretCipher } from "./webhook-secret-cipher.js";
import { createWebhookTargetPolicy } from "./webhook-target-policy.js";

export type ConstructedWebhookWorkerService = Readonly<{
  application: RuntimeRoleApplication;
  port: number;
}>;

export function constructWebhookWorkerService(
  environment: StartupEnvironment,
): ConstructedWebhookWorkerService {
  const port = parsePort(environment.PORT);
  const databaseUrl = parsePostgresUrl(environment.DATABASE_URL);
  const redisUrl = parseRedisUrl(environment.REDIS_URL);
  const queueName = parseQueueName(environment.WEBHOOK_QUEUE_NAME);
  const queuePrefix = parseQueuePrefix(environment.WEBHOOK_QUEUE_PREFIX);
  const readinessTimeoutMs = parsePositiveInteger(
    environment.RUNTIME_ROLE_READINESS_TIMEOUT_MS,
    2_000,
    "RUNTIME_ROLE_READINESS_TIMEOUT_MS",
  );
  const redisConnectionTimeoutMs = parsePositiveInteger(
    environment.ASYNC_REDIS_CONNECTION_TIMEOUT_MS,
    5_000,
    "ASYNC_REDIS_CONNECTION_TIMEOUT_MS",
  );
  const claimLeaseMs = parsePositiveInteger(
    environment.WEBHOOK_DELIVERY_CLAIM_LEASE_MS,
    30_000,
    "WEBHOOK_DELIVERY_CLAIM_LEASE_MS",
  );
  const requestTimeoutMs = parsePositiveInteger(
    environment.WEBHOOK_REQUEST_TIMEOUT_MS,
    20_000,
    "WEBHOOK_REQUEST_TIMEOUT_MS",
  );
  if (claimLeaseMs <= requestTimeoutMs) {
    throw new Error(
      "WEBHOOK_DELIVERY_CLAIM_LEASE_MS must exceed WEBHOOK_REQUEST_TIMEOUT_MS",
    );
  }
  const dispatchBatchSize = parseBoundedPositiveInteger(
    environment.WEBHOOK_OUTBOX_DISPATCH_BATCH_SIZE,
    25,
    "WEBHOOK_OUTBOX_DISPATCH_BATCH_SIZE",
    100,
  );
  const outboxClaimLeaseMs = parsePositiveInteger(
    environment.WEBHOOK_OUTBOX_CLAIM_LEASE_MS,
    30_000,
    "WEBHOOK_OUTBOX_CLAIM_LEASE_MS",
  );
  const dispatchIntervalMs = parsePositiveInteger(
    environment.WEBHOOK_OUTBOX_DISPATCH_INTERVAL_MS,
    1_000,
    "WEBHOOK_OUTBOX_DISPATCH_INTERVAL_MS",
  );
  const allowInsecureHttp = parseBoolean(
    environment.WEBHOOK_ALLOW_INSECURE_HTTP,
    false,
    "WEBHOOK_ALLOW_INSECURE_HTTP",
  );
  const allowUnsafeTargets = parseBoolean(
    environment.WEBHOOK_TEST_ALLOW_UNSAFE_TARGETS,
    false,
    "WEBHOOK_TEST_ALLOW_UNSAFE_TARGETS",
  );
  if (
    (allowInsecureHttp || allowUnsafeTargets) &&
    environment.NODE_ENV !== "test"
  ) {
    throw new Error("Unsafe Webhook targets are allowed only when NODE_ENV=test");
  }
  const encryptionKey = optionalNonEmpty(
    environment.WEBHOOK_SECRET_ENCRYPTION_KEY,
  );
  if (!encryptionKey) {
    throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEY is required for the Webhook Worker role");
  }
  const targetPolicy = createWebhookTargetPolicy({
    allowInsecureHttp,
    allowUnsafeAddresses: allowUnsafeTargets,
  });
  const secretCipher = createWebhookSecretCipher({ key: encryptionKey });
  const pool = new Pool({
    connectionString: databaseUrl,
    max: parsePositiveInteger(
      environment.ASYNC_POSTGRES_POOL_MAX,
      10,
      "ASYNC_POSTGRES_POOL_MAX",
    ),
    connectionTimeoutMillis: parsePositiveInteger(
      environment.ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS,
      5_000,
      "ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS",
    ),
    application_name: "pipipi-webhook-worker",
  });
  pool.on("error", () => {
    console.error(
      JSON.stringify({
        event: "postgres_pool_error",
        role: "pipipi-webhook-worker",
        timestamp: new Date().toISOString(),
      }),
    );
  });
  const store = createPostgresWebhookDeliveryStore({
    pool,
    claimLeaseMs,
    secretCipher,
    targetPolicy,
  });
  const queue = createBullMqWebhookWorkQueue({
    redisUrl,
    queueName,
    prefix: queuePrefix,
    connectTimeoutMs: redisConnectionTimeoutMs,
  });
  const worker = createBullMqWebhookWorker({
    redisUrl,
    queueName,
    prefix: queuePrefix,
    concurrency: parsePositiveInteger(
      environment.WEBHOOK_WORKER_CONCURRENCY,
      4,
      "WEBHOOK_WORKER_CONCURRENCY",
    ),
    workerName: optionalNonEmpty(environment.WEBHOOK_WORKER_NAME),
    shutdownGraceMs: parsePositiveInteger(
      environment.WEBHOOK_WORKER_SHUTDOWN_GRACE_MS,
      30_000,
      "WEBHOOK_WORKER_SHUTDOWN_GRACE_MS",
    ),
    lockDurationMs: parsePositiveInteger(
      environment.WEBHOOK_WORKER_LOCK_DURATION_MS,
      30_000,
      "WEBHOOK_WORKER_LOCK_DURATION_MS",
    ),
    stalledIntervalMs: parsePositiveInteger(
      environment.WEBHOOK_WORKER_STALLED_INTERVAL_MS,
      30_000,
      "WEBHOOK_WORKER_STALLED_INTERVAL_MS",
    ),
    maxStalledCount: parsePositiveInteger(
      environment.WEBHOOK_WORKER_MAX_STALLED_COUNT,
      1,
      "WEBHOOK_WORKER_MAX_STALLED_COUNT",
    ),
    worker: createWebhookDeliveryWorker({
      store,
      sender: createStandardWebhookHttpSender({
        timeoutMs: requestTimeoutMs,
        targetPolicy,
      }),
      retryPolicy: {
        maximumAttempts: parseBoundedPositiveInteger(
          environment.WEBHOOK_DELIVERY_MAX_ATTEMPTS,
          8,
          "WEBHOOK_DELIVERY_MAX_ATTEMPTS",
          20,
        ),
        initialBackoffMs: parsePositiveInteger(
          environment.WEBHOOK_DELIVERY_INITIAL_BACKOFF_MS,
          5_000,
          "WEBHOOK_DELIVERY_INITIAL_BACKOFF_MS",
        ),
        maximumBackoffMs: parsePositiveInteger(
          environment.WEBHOOK_DELIVERY_MAX_BACKOFF_MS,
          86_400_000,
          "WEBHOOK_DELIVERY_MAX_BACKOFF_MS",
        ),
        maximumRetryAfterMs: parsePositiveInteger(
          environment.WEBHOOK_DELIVERY_MAX_RETRY_AFTER_MS,
          86_400_000,
          "WEBHOOK_DELIVERY_MAX_RETRY_AFTER_MS",
        ),
        deliveryHorizonMs: parsePositiveInteger(
          environment.WEBHOOK_DELIVERY_HORIZON_MS,
          259_200_000,
          "WEBHOOK_DELIVERY_HORIZON_MS",
        ),
        jitterPercent: parseBoundedNonNegativeInteger(
          environment.WEBHOOK_DELIVERY_JITTER_PERCENT,
          20,
          "WEBHOOK_DELIVERY_JITTER_PERCENT",
          100,
        ),
      },
      logSink: writeAsyncOperationalLog,
    }),
  });
  const runtime = createWebhookWorkerRuntime({
    dispatcher: createWebhookOutboxDispatcher({
      outbox: createPostgresWebhookOutbox({ pool }),
      queue,
      batchSize: dispatchBatchSize,
      claimLeaseMs: outboxClaimLeaseMs,
      logSink: writeAsyncOperationalLog,
    }),
    worker,
    databaseReady: store.ready,
    queueReady: queue.ready,
    closeResources: async () => {
      try {
        await queue.close();
      } finally {
        await pool.end();
      }
    },
    dispatchIntervalMs,
  });

  return Object.freeze({
    application: createRuntimeRoleApplication({
      role: "webhook-worker",
      runtime,
      readinessTimeoutMs,
    }),
    port,
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
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const parsed = parsePositiveInteger(value, fallback, name);
  if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return parsed;
}

function parseBoundedNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`);
  }
  return parsed;
}

function parsePostgresUrl(value: string | undefined): string {
  return parseConnectionUrl(
    value,
    ["postgres:", "postgresql:"],
    "DATABASE_URL is required for the Webhook Worker role",
    "DATABASE_URL must be a valid PostgreSQL connection URL",
    true,
  );
}

function parseRedisUrl(value: string | undefined): string {
  return parseConnectionUrl(
    value,
    ["redis:", "rediss:"],
    "REDIS_URL is required for the Webhook Worker role",
    "REDIS_URL must be a valid redis:// or rediss:// URL",
    false,
  );
}

function parseConnectionUrl(
  value: string | undefined,
  protocols: readonly string[],
  missingMessage: string,
  invalidMessage: string,
  requireDatabasePath: boolean,
): string {
  const candidate = value?.trim();
  if (!candidate) throw new Error(missingMessage);
  try {
    const url = new URL(candidate);
    if (
      !protocols.includes(url.protocol) ||
      url.hostname.length === 0 ||
      (requireDatabasePath && url.pathname.length <= 1)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(invalidMessage);
  }
  return candidate;
}

function parseQueueName(value: string | undefined): string | undefined {
  return parseQueueComponent(value, "WEBHOOK_QUEUE_NAME", false);
}

function parseQueuePrefix(value: string | undefined): string | undefined {
  return parseQueueComponent(value, "WEBHOOK_QUEUE_PREFIX", true);
}

function parseQueueComponent(
  value: string | undefined,
  name: string,
  allowColon: boolean,
): string | undefined {
  if (value === undefined) return undefined;
  const candidate = value.trim();
  const pattern = allowColon ? /^[a-zA-Z0-9:_-]+$/ : /^[a-zA-Z0-9_-]+$/;
  if (
    candidate.length === 0 ||
    candidate.length > 128 ||
    (!allowColon && candidate.includes(":")) ||
    !pattern.test(candidate)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return candidate;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}
