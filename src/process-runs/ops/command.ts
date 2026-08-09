import { Pool } from "pg";
import type { StartupEnvironment } from "../../api/bootstrap.js";
import {
    type BullMqWebhookWorkQueue,
    createBullMqWebhookWorkQueue,
} from "../../webhooks/bullmq-queue.js";
import {
    type BullMqProcessWorkQueue,
    createBullMqProcessWorkQueue,
} from "../queue/bullmq.js";
import type { BullMqQueueSnapshot } from "../queue/observability.js";
import {
    createPostgresAsyncOperations,
    type PostgresAsyncOperationsSnapshot,
} from "./index.js";

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
    const databaseUrl = parseConnectionUrl(
        environment.DATABASE_URL,
        ["postgres:", "postgresql:"],
        "DATABASE_URL is required for Async Operations",
        "DATABASE_URL must be a valid PostgreSQL connection URL",
        true,
    );
    const redisUrl = parseConnectionUrl(
        environment.REDIS_URL,
        ["redis:", "rediss:"],
        "REDIS_URL is required for Async Operations",
        "REDIS_URL must be a valid redis:// or rediss:// URL",
        false,
    );
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

function reportPoolError(): void {
    console.error(
        JSON.stringify({
            event: "postgres_pool_error",
            role: "pipipi-async-operations",
            timestamp: new Date().toISOString(),
        }),
    );
}
