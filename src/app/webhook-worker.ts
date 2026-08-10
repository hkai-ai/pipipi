import { writeAsyncOperationalLog } from "../process-runs/ops/logging.js";
import { createWebhookOutboxDispatcher } from "../process-runs/outbox/dispatcher.js";
import {
    createStandardWebhookHttpSender,
    createWebhookDeliveryWorker,
} from "../webhooks/delivery/index.js";
import { createWebhookTargetPolicy } from "../webhooks/delivery/target-policy.js";
import { createPostgresWebhookOutbox } from "../webhooks/outbox/postgres.js";
import {
    createBullMqWebhookWorker,
    createBullMqWebhookWorkQueue,
} from "../webhooks/queue/bullmq.js";
import { createWebhookWorkerRuntime } from "../webhooks/runtime.js";
import { createPostgresWebhookDeliveryStore } from "../webhooks/store/postgres.js";
import { createWebhookSecretCipher } from "../webhooks/store/secret-cipher.js";
import {
    optionalNonEmpty,
    parseBoolean,
    parseBoundedNonNegativeInteger,
    parseBoundedPositiveInteger,
    parseConnectionUrl,
    parsePort,
    parsePositiveInteger,
    parseQueueComponent,
    type StartupEnvironment,
} from "./config.js";
import { assertDeploymentEnvironment } from "./deployment-environment.js";
import { createRuntimePool } from "./postgres.js";
import {
    type ConstructedRuntimeRoleService,
    constructRuntimeRoleService,
} from "./role.js";

export type ConstructedWebhookWorkerService = ConstructedRuntimeRoleService;

export function constructWebhookWorkerService(
    environment: StartupEnvironment,
): ConstructedWebhookWorkerService {
    assertDeploymentEnvironment(environment, "webhook-worker");
    const port = parsePort(environment.PORT);
    const databaseUrl = parseConnectionUrl(environment.DATABASE_URL, {
        protocols: ["postgres:", "postgresql:"],
        missingMessage: "DATABASE_URL is required for the Webhook Worker role",
        invalidMessage:
            "DATABASE_URL must be a valid PostgreSQL connection URL",
        requirePath: true,
    });
    const redisUrl = parseConnectionUrl(environment.REDIS_URL, {
        protocols: ["redis:", "rediss:"],
        missingMessage: "REDIS_URL is required for the Webhook Worker role",
        invalidMessage: "REDIS_URL must be a valid redis:// or rediss:// URL",
    });
    const queueName = parseQueueComponent(
        environment.WEBHOOK_QUEUE_NAME,
        "WEBHOOK_QUEUE_NAME",
        false,
    );
    const queuePrefix = parseQueueComponent(
        environment.WEBHOOK_QUEUE_PREFIX,
        "WEBHOOK_QUEUE_PREFIX",
        true,
    );
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
        throw new Error(
            "Unsafe Webhook targets are allowed only when NODE_ENV=test",
        );
    }
    const encryptionKey = optionalNonEmpty(
        environment.WEBHOOK_SECRET_ENCRYPTION_KEY,
    );
    if (!encryptionKey) {
        throw new Error(
            "WEBHOOK_SECRET_ENCRYPTION_KEY is required for the Webhook Worker role",
        );
    }
    const targetPolicy = createWebhookTargetPolicy({
        allowInsecureHttp,
        allowUnsafeAddresses: allowUnsafeTargets,
    });
    const secretCipher = createWebhookSecretCipher({ key: encryptionKey });
    const pool = createRuntimePool({
        environment,
        connectionString: databaseUrl,
        applicationName: "pipipi-webhook-worker",
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

    return constructRuntimeRoleService({
        role: "webhook-worker",
        runtime,
        port,
        readinessTimeoutMs,
    });
}
