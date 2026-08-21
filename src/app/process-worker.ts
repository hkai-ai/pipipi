/** Process Worker 角色独立的配置和 Adapter 组装 */
import { writeAsyncOperationalLog } from "../process-runs/ops/logging.js";
import { createBullMqProcessWorker } from "../process-runs/queue/bullmq.js";
import { createPostgresProcessRunStore } from "../process-runs/store/postgres.js";
import { createProcessWorker } from "../process-runs/worker/index.js";
import {
    combineProcessRunLogSinks,
    createProcessAttemptRunner,
} from "../process-runtime/index.js";
import { createPinoProcessRunLogSink } from "../run-observation/pino.js";
import { createProductionRuntime } from "./business-processes.js";
import {
    optionalNonEmpty,
    parseBoundedPositiveInteger,
    parsePort,
    parsePositiveInteger,
    parseRequiredPositiveInteger,
    type StartupEnvironment,
} from "./config.js";
import { assertDeploymentEnvironment } from "./deployment-environment.js";
import { createRuntimePool } from "./postgres-pool.js";
import { loadProcessRunConnections } from "./process-run-config.js";
import {
    type BackgroundRuntime,
    type ConstructedRuntimeRoleService,
    constructRuntimeRoleService,
} from "./role.js";
import { constructProcessRunObservation } from "./run-observation.js";

export function constructProcessWorkerService(
    environment: StartupEnvironment,
): ConstructedRuntimeRoleService {
    assertDeploymentEnvironment(environment, "process-worker", {
        includeProviderCredentials: environment.NODE_ENV === "production",
    });
    const pinoRunLogSink = createPinoProcessRunLogSink({
        level: environment.PROCESS_RUN_LOG_LEVEL,
    });
    const observation = constructProcessRunObservation(environment);
    const runLogSink = observation
        ? combineProcessRunLogSinks(
              pinoRunLogSink,
              observation.activities.record,
          )
        : pinoRunLogSink;
    const processRuntime = createProductionRuntime(environment, { runLogSink });
    const port = parsePort(environment.PORT);
    const readinessTimeoutMs = parsePositiveInteger(
        environment.RUNTIME_ROLE_READINESS_TIMEOUT_MS,
        2_000,
        "RUNTIME_ROLE_READINESS_TIMEOUT_MS",
    );
    const connections = loadProcessRunConnections(environment);
    const processTimeoutMs = parsePositiveInteger(
        environment.PROCESS_TIMEOUT_MS,
        30_000,
        "PROCESS_TIMEOUT_MS",
    );
    const observationTimeoutMs = parsePositiveInteger(
        environment.PROCESS_RUN_OBSERVATION_TIMEOUT_MS,
        2_000,
        "PROCESS_RUN_OBSERVATION_TIMEOUT_MS",
    );
    const shutdownGraceMs = parseBoundedPositiveInteger(
        environment.PROCESS_WORKER_SHUTDOWN_GRACE_MS,
        30_000,
        "PROCESS_WORKER_SHUTDOWN_GRACE_MS",
        60_000,
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
            "PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS is required for the Process Worker role",
        ),
        resultMs: parseRequiredPositiveInteger(
            environment.PROCESS_RUN_RESULT_RETENTION_MS,
            "PROCESS_RUN_RESULT_RETENTION_MS",
            "PROCESS_RUN_RESULT_RETENTION_MS is required for the Process Worker role",
        ),
        metadataMs: parseRequiredPositiveInteger(
            environment.PROCESS_RUN_METADATA_RETENTION_MS,
            "PROCESS_RUN_METADATA_RETENTION_MS",
            "PROCESS_RUN_METADATA_RETENTION_MS is required for the Process Worker role",
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
    const pool = createRuntimePool({
        environment,
        connectionString: connections.databaseUrl,
        applicationName: "pipipi-process-worker",
    });
    const store = createPostgresProcessRunStore({
        pool,
        retention,
        claimLeaseMs,
    });
    const worker = createBullMqProcessWorker({
        redisUrl: connections.redisUrl,
        queueName: connections.queueName,
        prefix: connections.queuePrefix,
        concurrency,
        workerName: optionalNonEmpty(environment.PROCESS_WORKER_NAME),
        shutdownGraceMs,
        lockDurationMs,
        stalledIntervalMs,
        maxStalledCount,
        worker: createProcessWorker({
            registry: processRuntime.registry,
            store,
            attemptRunner: createProcessAttemptRunner({
                processTimeoutMs,
                logSink: runLogSink,
            }),
            runRecords: observation?.records,
            observationTimeoutMs,
            logSink: writeAsyncOperationalLog,
        }),
    });
    const runtime: BackgroundRuntime = Object.freeze({
        start: worker.start,
        ready: async () => {
            await Promise.all([store.ready(), worker.ready()]);
        },
        close: async () => {
            const failures: unknown[] = [];
            try {
                await worker.close();
            } catch (error) {
                failures.push(error);
            }
            const closed = await Promise.allSettled([
                pool.end(),
                ...(observation?.close ? [observation.close()] : []),
            ]);
            for (const result of closed) {
                if (result.status === "rejected") failures.push(result.reason);
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
                throw new AggregateError(
                    failures,
                    "Process Worker resources failed to close",
                );
            }
        },
    });

    return constructRuntimeRoleService({
        role: "process-worker",
        runtime,
        port,
        readinessTimeoutMs,
    });
}
