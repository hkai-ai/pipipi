import { createBullMqProcessWorkQueue } from "../process-runs/queue/bullmq.js";
import {
    createProcessRunReconciler,
    type ProcessRunReconciler,
} from "../process-runs/recovery/index.js";
import { createPostgresProcessRunRecoverySource } from "../process-runs/recovery/postgres.js";
import {
    parseBoundedPositiveInteger,
    parsePositiveInteger,
    type StartupEnvironment,
} from "./config.js";
import { assertDeploymentEnvironment } from "./deployment-environment.js";
import { createRuntimePool } from "./postgres.js";
import { loadProcessRunConnections } from "./process-run-config.js";

export type ConstructedProcessRecoveryCommand = Readonly<{
    reconciler: ProcessRunReconciler;
    ready: () => Promise<void>;
    close: () => Promise<void>;
}>;

export function constructProcessRecoveryCommand(
    environment: StartupEnvironment,
): ConstructedProcessRecoveryCommand {
    assertDeploymentEnvironment(environment, "process-recovery");
    const connections = loadProcessRunConnections(environment);
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
    const pool = createRuntimePool({
        environment,
        connectionString: connections.databaseUrl,
        applicationName: "pipipi-process-recovery",
    });
    const queue = createBullMqProcessWorkQueue({
        redisUrl: connections.redisUrl,
        queueName: connections.queueName,
        prefix: connections.queuePrefix,
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
