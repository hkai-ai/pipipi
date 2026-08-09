import { Pool } from "pg";
import {
    constructBusinessProcessRuntime,
    type StartupEnvironment,
} from "../api/bootstrap.js";
import {
    type BackgroundRuntime,
    createRuntimeRoleApplication,
    type RuntimeRoleApplication,
    type RuntimeRoleName,
} from "../api/role.js";
import { createProcessAttemptRunner } from "../processes/runtime.js";
import { createProcessDispatcherRuntime } from "./dispatcher.js";
import { writeAsyncOperationalLog } from "./ops/logging.js";
import { createOutboxDispatcher } from "./outbox/dispatcher.js";
import { createPostgresProcessOutbox } from "./outbox/postgres.js";
import {
    createBullMqProcessWorker,
    createBullMqProcessWorkQueue,
} from "./queue/bullmq.js";
import {
    createProcessRunReconciler,
    type ProcessRunReconciler,
} from "./recovery/index.js";
import {
    createRetentionCleaner,
    createRetentionCleanerRuntime,
} from "./retention/index.js";
import { createPostgresRetentionCleanup } from "./retention/postgres.js";
import {
    createPostgresProcessRunRecoverySource,
    createPostgresProcessRunStore,
} from "./store/postgres.js";
import { createProcessWorker } from "./worker/index.js";

export type ConstructedRuntimeRoleService = Readonly<{
    application: RuntimeRoleApplication;
    port: number;
}>;

export type ConstructedProcessRecoveryCommand = Readonly<{
    reconciler: ProcessRunReconciler;
    ready: () => Promise<void>;
    close: () => Promise<void>;
}>;

export function constructProcessDispatcherService(
    environment: StartupEnvironment,
): ConstructedRuntimeRoleService {
    const port = parsePort(environment.PORT);
    const readinessTimeoutMs = parsePositiveInteger(
        environment.RUNTIME_ROLE_READINESS_TIMEOUT_MS,
        2_000,
        "RUNTIME_ROLE_READINESS_TIMEOUT_MS",
    );
    const databaseUrl = parsePostgresConnectionString(environment.DATABASE_URL);
    const redisUrl = parseRedisConnectionString(environment.REDIS_URL);
    const queueName = parseQueueName(environment.PROCESS_QUEUE_NAME);
    const queuePrefix = parseQueuePrefix(environment.PROCESS_QUEUE_PREFIX);
    const redisConnectionTimeoutMs = parsePositiveInteger(
        environment.ASYNC_REDIS_CONNECTION_TIMEOUT_MS,
        5_000,
        "ASYNC_REDIS_CONNECTION_TIMEOUT_MS",
    );
    const dispatchBatchSize = parseBoundedPositiveInteger(
        environment.OUTBOX_DISPATCH_BATCH_SIZE,
        25,
        "OUTBOX_DISPATCH_BATCH_SIZE",
        100,
    );
    const outboxClaimLeaseMs = parsePositiveInteger(
        environment.OUTBOX_CLAIM_LEASE_MS,
        30_000,
        "OUTBOX_CLAIM_LEASE_MS",
    );
    const queuedAgeMs = parsePositiveInteger(
        environment.PROCESS_RUN_RECONCILE_QUEUED_AGE_MS,
        60_000,
        "PROCESS_RUN_RECONCILE_QUEUED_AGE_MS",
    );
    const reconciliationBatchSize = parseBoundedPositiveInteger(
        environment.PROCESS_RUN_RECONCILE_BATCH_SIZE,
        25,
        "PROCESS_RUN_RECONCILE_BATCH_SIZE",
        100,
    );
    const dispatchIntervalMs = parsePositiveInteger(
        environment.OUTBOX_DISPATCH_INTERVAL_MS,
        1_000,
        "OUTBOX_DISPATCH_INTERVAL_MS",
    );
    const reconciliationIntervalMs = parsePositiveInteger(
        environment.PROCESS_RUN_RECONCILE_INTERVAL_MS,
        30_000,
        "PROCESS_RUN_RECONCILE_INTERVAL_MS",
    );
    const pool = createPool(
        environment,
        databaseUrl,
        "pipipi-process-dispatcher",
    );
    const queue = createBullMqProcessWorkQueue({
        redisUrl,
        queueName,
        prefix: queuePrefix,
        connectTimeoutMs: redisConnectionTimeoutMs,
    });
    const dispatcher = createOutboxDispatcher({
        outbox: createPostgresProcessOutbox({ pool }),
        queue,
        batchSize: dispatchBatchSize,
        claimLeaseMs: outboxClaimLeaseMs,
        logSink: writeAsyncOperationalLog,
    });
    const recoveryStore = createPostgresProcessRunRecoverySource({ pool });
    const reconciler = createProcessRunReconciler({
        store: recoveryStore,
        queue,
        queuedAgeMs,
        batchSize: reconciliationBatchSize,
    });
    const runtime = createProcessDispatcherRuntime({
        dispatcher,
        reconciler,
        databaseReady: async () => {
            await Promise.all([
                dispatcherDatabaseReady(pool),
                recoveryStore.ready(),
            ]);
        },
        queueReady: queue.ready,
        closeResources: async () => {
            try {
                await queue.close();
            } finally {
                await pool.end();
            }
        },
        dispatchIntervalMs,
        reconciliationIntervalMs,
    });

    return roleService("process-dispatcher", runtime, port, readinessTimeoutMs);
}

export function constructProcessWorkerService(
    environment: StartupEnvironment,
): ConstructedRuntimeRoleService {
    const businessRuntime = constructBusinessProcessRuntime(environment);
    const port = parsePort(environment.PORT);
    const readinessTimeoutMs = parsePositiveInteger(
        environment.RUNTIME_ROLE_READINESS_TIMEOUT_MS,
        2_000,
        "RUNTIME_ROLE_READINESS_TIMEOUT_MS",
    );
    const databaseUrl = parsePostgresConnectionString(environment.DATABASE_URL);
    const redisUrl = parseRedisConnectionString(environment.REDIS_URL);
    const queueName = parseQueueName(environment.PROCESS_QUEUE_NAME);
    const queuePrefix = parseQueuePrefix(environment.PROCESS_QUEUE_PREFIX);
    const processTimeoutMs = parsePositiveInteger(
        environment.PROCESS_TIMEOUT_MS,
        30_000,
        "PROCESS_TIMEOUT_MS",
    );
    const shutdownGraceMs = parsePositiveInteger(
        environment.PROCESS_WORKER_SHUTDOWN_GRACE_MS,
        30_000,
        "PROCESS_WORKER_SHUTDOWN_GRACE_MS",
    );
    const claimLeaseMs = parsePositiveInteger(
        environment.PROCESS_RUN_CLAIM_LEASE_MS,
        processTimeoutMs + 30_000,
        "PROCESS_RUN_CLAIM_LEASE_MS",
    );
    if (claimLeaseMs <= processTimeoutMs) {
        throw new Error(
            "PROCESS_RUN_CLAIM_LEASE_MS must exceed PROCESS_TIMEOUT_MS",
        );
    }
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
    const concurrency = parsePositiveInteger(
        environment.PROCESS_WORKER_CONCURRENCY,
        1,
        "PROCESS_WORKER_CONCURRENCY",
    );
    const lockDurationMs = parsePositiveInteger(
        environment.PROCESS_WORKER_LOCK_DURATION_MS,
        30_000,
        "PROCESS_WORKER_LOCK_DURATION_MS",
    );
    const stalledIntervalMs = parsePositiveInteger(
        environment.PROCESS_WORKER_STALLED_INTERVAL_MS,
        30_000,
        "PROCESS_WORKER_STALLED_INTERVAL_MS",
    );
    const maxStalledCount = parsePositiveInteger(
        environment.PROCESS_WORKER_MAX_STALLED_COUNT,
        1,
        "PROCESS_WORKER_MAX_STALLED_COUNT",
    );
    const pool = createPool(environment, databaseUrl, "pipipi-process-worker");
    const store = createPostgresProcessRunStore({
        pool,
        retention,
        claimLeaseMs,
    });
    const worker = createBullMqProcessWorker({
        redisUrl,
        queueName,
        prefix: queuePrefix,
        concurrency,
        workerName: optionalNonEmptyConfiguration(
            environment.PROCESS_WORKER_NAME,
        ),
        shutdownGraceMs,
        lockDurationMs,
        stalledIntervalMs,
        maxStalledCount,
        worker: createProcessWorker({
            registry: businessRuntime.registry,
            store,
            attemptRunner: createProcessAttemptRunner({ processTimeoutMs }),
            logSink: writeAsyncOperationalLog,
        }),
    });
    const runtime: BackgroundRuntime = Object.freeze({
        start: worker.start,
        ready: async () => {
            await Promise.all([store.ready(), worker.ready()]);
        },
        close: async () => {
            try {
                await worker.close();
            } finally {
                await pool.end();
            }
        },
    });

    return roleService("process-worker", runtime, port, readinessTimeoutMs);
}

export function constructRetentionCleanerService(
    environment: StartupEnvironment,
): ConstructedRuntimeRoleService {
    const port = parsePort(environment.PORT);
    const readinessTimeoutMs = parsePositiveInteger(
        environment.RUNTIME_ROLE_READINESS_TIMEOUT_MS,
        2_000,
        "RUNTIME_ROLE_READINESS_TIMEOUT_MS",
    );
    const databaseUrl = parsePostgresConnectionString(environment.DATABASE_URL);
    const deliveryHistoryMs = parsePositiveInteger(
        environment.WEBHOOK_DELIVERY_HISTORY_RETENTION_MS,
        2_592_000_000,
        "WEBHOOK_DELIVERY_HISTORY_RETENTION_MS",
    );
    const cleanupIntervalMs = parsePositiveInteger(
        environment.RETENTION_CLEANUP_INTERVAL_MS,
        3_600_000,
        "RETENTION_CLEANUP_INTERVAL_MS",
    );
    const batchSize = parseBoundedPositiveInteger(
        environment.RETENTION_CLEANUP_BATCH_SIZE,
        25,
        "RETENTION_CLEANUP_BATCH_SIZE",
        100,
    );
    const maximumBatchesPerSweep = parseBoundedPositiveInteger(
        environment.RETENTION_CLEANUP_MAX_BATCHES_PER_SWEEP,
        100,
        "RETENTION_CLEANUP_MAX_BATCHES_PER_SWEEP",
        10_000,
    );
    const pool = createPool(
        environment,
        databaseUrl,
        "pipipi-retention-cleaner",
    );
    const cleanup = createPostgresRetentionCleanup({
        pool,
        webhookDeliveryHistoryMs: deliveryHistoryMs,
    });
    const cleaner = createRetentionCleaner({
        cleanup,
        batchSize,
        maximumBatchesPerSweep,
    });
    const runtime = createRetentionCleanerRuntime({
        cleaner,
        databaseReady: cleanup.ready,
        closeResources: () => pool.end(),
        intervalMs: cleanupIntervalMs,
    });

    return roleService("retention-cleaner", runtime, port, readinessTimeoutMs);
}

export function constructProcessRecoveryCommand(
    environment: StartupEnvironment,
): ConstructedProcessRecoveryCommand {
    const databaseUrl = parsePostgresConnectionString(environment.DATABASE_URL);
    const redisUrl = parseRedisConnectionString(environment.REDIS_URL);
    const queueName = parseQueueName(environment.PROCESS_QUEUE_NAME);
    const queuePrefix = parseQueuePrefix(environment.PROCESS_QUEUE_PREFIX);
    const redisConnectionTimeoutMs = parsePositiveInteger(
        environment.ASYNC_REDIS_CONNECTION_TIMEOUT_MS,
        5_000,
        "ASYNC_REDIS_CONNECTION_TIMEOUT_MS",
    );
    const queuedAgeMs = parsePositiveInteger(
        environment.PROCESS_RUN_RECONCILE_QUEUED_AGE_MS,
        60_000,
        "PROCESS_RUN_RECONCILE_QUEUED_AGE_MS",
    );
    const batchSize = parseBoundedPositiveInteger(
        environment.PROCESS_RUN_RECONCILE_BATCH_SIZE,
        25,
        "PROCESS_RUN_RECONCILE_BATCH_SIZE",
        100,
    );
    const pool = createPool(
        environment,
        databaseUrl,
        "pipipi-process-recovery",
    );
    const queue = createBullMqProcessWorkQueue({
        redisUrl,
        queueName,
        prefix: queuePrefix,
        connectTimeoutMs: redisConnectionTimeoutMs,
    });
    const recoveryStore = createPostgresProcessRunRecoverySource({ pool });
    const reconciler = createProcessRunReconciler({
        store: recoveryStore,
        queue,
        queuedAgeMs,
        batchSize,
    });
    let closed = false;

    return Object.freeze({
        reconciler,
        ready: async () => {
            await Promise.all([recoveryStore.ready(), queue.ready()]);
        },
        close: async () => {
            if (closed) return;
            closed = true;
            try {
                await queue.close();
            } finally {
                await pool.end();
            }
        },
    });
}

function roleService(
    role: RuntimeRoleName,
    runtime: BackgroundRuntime,
    port: number,
    readinessTimeoutMs: number,
): ConstructedRuntimeRoleService {
    return Object.freeze({
        application: createRuntimeRoleApplication({
            role,
            runtime,
            readinessTimeoutMs,
        }),
        port,
    });
}

function createPool(
    environment: StartupEnvironment,
    connectionString: string,
    applicationName: string,
): Pool {
    const pool = new Pool({
        connectionString,
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
        application_name: applicationName,
    });
    pool.on("error", () => {
        console.error(
            JSON.stringify({
                event: "postgres_pool_error",
                role: applicationName,
                timestamp: new Date().toISOString(),
            }),
        );
    });
    return pool;
}

async function dispatcherDatabaseReady(pool: Pool): Promise<void> {
    const result = await pool.query<{
        process_runs: string | null;
        outbox_messages: string | null;
    }>(`
    SELECT
      to_regclass('public.process_runs')::text AS process_runs,
      to_regclass('public.outbox_messages')::text AS outbox_messages
  `);
    if (
        result.rows[0]?.process_runs !== "process_runs" ||
        result.rows[0]?.outbox_messages !== "outbox_messages"
    ) {
        throw new Error("Async Process Run database migration is not ready");
    }
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

function parseRequiredPositiveInteger(
    value: string | undefined,
    name: string,
): number {
    if (value === undefined) {
        throw new Error(`${name} is required for the Process Worker role`);
    }
    return parsePositiveInteger(value, 1, name);
}

function parseBoundedPositiveInteger(
    value: string | undefined,
    fallback: number,
    name: string,
    maximum: number,
): number {
    const parsed = parsePositiveInteger(value, fallback, name);
    if (parsed > maximum) {
        throw new Error(`${name} must not exceed ${maximum}`);
    }
    return parsed;
}

function parsePostgresConnectionString(value: string | undefined): string {
    const candidate = value?.trim();
    if (!candidate)
        throw new Error("DATABASE_URL is required for this runtime role");
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

function parseRedisConnectionString(value: string | undefined): string {
    const candidate = value?.trim();
    if (!candidate)
        throw new Error("REDIS_URL is required for this runtime role");
    try {
        const url = new URL(candidate);
        if (
            (url.protocol !== "redis:" && url.protocol !== "rediss:") ||
            url.hostname.length === 0
        ) {
            throw new Error();
        }
    } catch {
        throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL");
    }
    return candidate;
}

function optionalConfiguration(value: string | undefined): string | undefined {
    return value === undefined ? undefined : value.trim();
}

function optionalNonEmptyConfiguration(
    value: string | undefined,
): string | undefined {
    const candidate = value?.trim();
    return candidate ? candidate : undefined;
}

function parseQueueName(value: string | undefined): string | undefined {
    const name = optionalConfiguration(value);
    if (
        name !== undefined &&
        (name.length === 0 ||
            name.length > 128 ||
            name.includes(":") ||
            !/^[a-zA-Z0-9_-]+$/.test(name))
    ) {
        throw new Error("PROCESS_QUEUE_NAME is invalid");
    }
    return name;
}

function parseQueuePrefix(value: string | undefined): string | undefined {
    const prefix = optionalConfiguration(value);
    if (
        prefix !== undefined &&
        (prefix.length === 0 ||
            prefix.length > 128 ||
            !/^[a-zA-Z0-9:_-]+$/.test(prefix))
    ) {
        throw new Error("PROCESS_QUEUE_PREFIX is invalid");
    }
    return prefix;
}
