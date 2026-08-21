import {
    createRetentionCleaner,
    createRetentionCleanerRuntime,
} from "../process-runs/retention/index.js";
import { createPostgresRetentionCleanup } from "../process-runs/retention/postgres.js";
import {
    parseBoundedPositiveInteger,
    parsePort,
    parsePositiveInteger,
    type StartupEnvironment,
} from "./config.js";
import { assertDeploymentEnvironment } from "./deployment-environment.js";
import { createRuntimePool } from "./postgres-pool.js";
import { parseProcessRunDatabaseUrl } from "./process-run-config.js";
import {
    type ConstructedRuntimeRoleService,
    constructRuntimeRoleService,
} from "./role.js";

export function constructRetentionCleanerService(
    environment: StartupEnvironment,
): ConstructedRuntimeRoleService {
    assertDeploymentEnvironment(environment, "retention-cleaner");
    const port = parsePort(environment.PORT);
    const readinessTimeoutMs = parsePositiveInteger(
        environment.RUNTIME_ROLE_READINESS_TIMEOUT_MS,
        2_000,
        "RUNTIME_ROLE_READINESS_TIMEOUT_MS",
    );
    const databaseUrl = parseProcessRunDatabaseUrl(environment.DATABASE_URL);
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
    const pool = createRuntimePool({
        environment,
        connectionString: databaseUrl,
        applicationName: "pipipi-retention-cleaner",
    });
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

    return constructRuntimeRoleService({
        role: "retention-cleaner",
        runtime,
        port,
        readinessTimeoutMs,
    });
}
