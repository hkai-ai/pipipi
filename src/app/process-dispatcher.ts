/** Dispatcher 角色独立的配置和 Adapter 组装 */
import type { Pool } from "pg";
import { createProcessDispatcherRuntime } from "../process-runs/dispatcher.js";
import { writeAsyncOperationalLog } from "../process-runs/ops/logging.js";
import { createOutboxDispatcher } from "../process-runs/outbox/dispatcher.js";
import { createPostgresProcessOutbox } from "../process-runs/outbox/postgres.js";
import { createBullMqProcessWorkQueue } from "../process-runs/queue/bullmq.js";
import { createProcessRunReconciler } from "../process-runs/recovery/index.js";
import { createPostgresProcessRunRecoverySource } from "../process-runs/recovery/postgres.js";
import {
    parseBoundedPositiveInteger,
    parsePort,
    parsePositiveInteger,
    type StartupEnvironment,
} from "./config.js";
import { assertDeploymentEnvironment } from "./deployment-environment.js";
import { createRuntimePool } from "./postgres-pool.js";
import { loadProcessRunConnections } from "./process-run-config.js";
import {
    type ConstructedRuntimeRoleService,
    constructRuntimeRoleService,
} from "./role.js";

export function constructProcessDispatcherService(
    environment: StartupEnvironment,
): ConstructedRuntimeRoleService {
    assertDeploymentEnvironment(environment, "process-dispatcher");
    const port = parsePort(environment.PORT);
    const readinessTimeoutMs = parsePositiveInteger(
        environment.RUNTIME_ROLE_READINESS_TIMEOUT_MS,
        2_000,
        "RUNTIME_ROLE_READINESS_TIMEOUT_MS",
    );
    const connections = loadProcessRunConnections(environment);
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
    const pool = createRuntimePool({
        environment,
        connectionString: connections.databaseUrl,
        applicationName: "pipipi-process-dispatcher",
    });
    const queue = createBullMqProcessWorkQueue({
        redisUrl: connections.redisUrl,
        queueName: connections.queueName,
        prefix: connections.queuePrefix,
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

    return constructRuntimeRoleService({
        role: "process-dispatcher",
        runtime,
        port,
        readinessTimeoutMs,
    });
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
