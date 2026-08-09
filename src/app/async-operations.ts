import { Pool } from "pg";
import {
    createPostgresAsyncOperations,
    type PostgresAsyncOperationsSnapshot,
} from "../process-runs/ops/postgres.js";
import {
    type BullMqProcessWorkQueue,
    createBullMqProcessWorkQueue,
} from "../process-runs/queue/bullmq.js";
import type { BullMqQueueSnapshot } from "../process-runs/queue/observability.js";
import {
    type BullMqWebhookWorkQueue,
    createBullMqWebhookWorkQueue,
} from "../webhooks/queue/bullmq.js";
import {
    parseConnectionUrl,
    parsePositiveInteger,
    type StartupEnvironment,
} from "./config.js";

export type AsyncOperationsCommandSnapshot = Readonly<{
    schemaVersion: 1;
    measuredAt: string;
    persistence: PostgresAsyncOperationsSnapshot;
    queues: Readonly<{
        process: BullMqQueueSnapshot;
        webhook: BullMqQueueSnapshot;
    }>;
}>;

export type AsyncOperationsCommand = Readonly<{
    ready: () => Promise<void>;
    snapshot: () => Promise<AsyncOperationsCommandSnapshot>;
    close: () => Promise<void>;
}>;

export function constructAsyncOperationsCommand(
    environment: StartupEnvironment,
): AsyncOperationsCommand {
    const databaseUrl = parseConnectionUrl(environment.DATABASE_URL, {
        protocols: ["postgres:", "postgresql:"],
        missingMessage: "DATABASE_URL is required for Async Operations",
        invalidMessage:
            "DATABASE_URL must be a valid PostgreSQL connection URL",
        requirePath: true,
    });
    const redisUrl = parseConnectionUrl(environment.REDIS_URL, {
        protocols: ["redis:", "rediss:"],
        missingMessage: "REDIS_URL is required for Async Operations",
        invalidMessage: "REDIS_URL must be a valid redis:// or rediss:// URL",
    });
    const connectTimeoutMs = parsePositiveInteger(
        environment.ASYNC_REDIS_CONNECTION_TIMEOUT_MS,
        5_000,
        "ASYNC_REDIS_CONNECTION_TIMEOUT_MS",
    );
    const pool = new Pool({
        connectionString: databaseUrl,
        max: parsePositiveInteger(
            environment.ASYNC_POSTGRES_POOL_MAX,
            4,
            "ASYNC_POSTGRES_POOL_MAX",
        ),
        connectionTimeoutMillis: parsePositiveInteger(
            environment.ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS,
            5_000,
            "ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS",
        ),
        application_name: "pipipi-async-operations",
    });
    pool.on("error", reportPoolError);
    const processQueue: BullMqProcessWorkQueue = createBullMqProcessWorkQueue({
        redisUrl,
        queueName: environment.PROCESS_QUEUE_NAME,
        prefix: environment.PROCESS_QUEUE_PREFIX,
        connectTimeoutMs,
    });
    const webhookQueue: BullMqWebhookWorkQueue = createBullMqWebhookWorkQueue({
        redisUrl,
        queueName: environment.WEBHOOK_QUEUE_NAME,
        prefix: environment.WEBHOOK_QUEUE_PREFIX,
        connectTimeoutMs,
    });
    const operations = createPostgresAsyncOperations({
        pool,
        recentWindowMs: parsePositiveInteger(
            environment.ASYNC_OPERATIONS_RECENT_WINDOW_MS,
            900_000,
            "ASYNC_OPERATIONS_RECENT_WINDOW_MS",
        ),
        stuckRunAgeMs: parsePositiveInteger(
            environment.ASYNC_STUCK_RUN_AGE_MS,
            300_000,
            "ASYNC_STUCK_RUN_AGE_MS",
        ),
    });
    let closed = false;

    return Object.freeze({
        ready: async () => {
            if (closed) throw new Error("Async Operations command is closed");
            await Promise.all([
                operations.ready(),
                processQueue.ready(),
                webhookQueue.ready(),
            ]);
        },
        snapshot: async () => {
            if (closed) throw new Error("Async Operations command is closed");
            const measuredAt = new Date().toISOString();
            const asOfMilliseconds = new Date(measuredAt).getTime();
            const [persistence, process, webhook] = await Promise.all([
                operations.snapshot({ asOf: measuredAt }),
                processQueue.snapshot(asOfMilliseconds),
                webhookQueue.snapshot(asOfMilliseconds),
            ]);
            return Object.freeze({
                schemaVersion: 1 as const,
                measuredAt,
                persistence,
                queues: Object.freeze({ process, webhook }),
            });
        },
        close: async () => {
            if (closed) return;
            closed = true;
            const results = await Promise.allSettled([
                processQueue.close(),
                webhookQueue.close(),
                pool.end(),
            ]);
            const failed = results.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );
            if (failed) throw failed.reason;
            pool.off("error", reportPoolError);
        },
    });
}

function reportPoolError(): void {
    console.error(
        JSON.stringify({
            event: "postgres_pool_error",
            role: "pipipi-async-operations",
            timestamp: new Date().toISOString(),
        }),
    );
}
