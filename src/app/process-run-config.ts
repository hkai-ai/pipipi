/** 解析 Process Runner 所需的数据库、Redis 连接及队列命名配置 */
import {
    parseConnectionUrl,
    parseQueueComponent,
    type StartupEnvironment,
} from "./config.js";

export type ProcessRunConnections = Readonly<{
    databaseUrl: string;
    redisUrl: string;
    queueName: string | undefined;
    queuePrefix: string | undefined;
}>;

export function loadProcessRunConnections(
    environment: StartupEnvironment,
): ProcessRunConnections {
    return Object.freeze({
        databaseUrl: parseProcessRunDatabaseUrl(environment.DATABASE_URL),
        redisUrl: parseProcessRunRedisUrl(environment.REDIS_URL),
        queueName: parseQueueComponent(
            environment.PROCESS_QUEUE_NAME,
            "PROCESS_QUEUE_NAME",
            false,
        ),
        queuePrefix: parseQueueComponent(
            environment.PROCESS_QUEUE_PREFIX,
            "PROCESS_QUEUE_PREFIX",
            true,
        ),
    });
}

export function parseProcessRunDatabaseUrl(value: string | undefined): string {
    return parseConnectionUrl(value, {
        protocols: ["postgres:", "postgresql:"],
        missingMessage: "DATABASE_URL is required for this runtime role",
        invalidMessage:
            "DATABASE_URL must be a valid PostgreSQL connection URL",
        requirePath: true,
    });
}

function parseProcessRunRedisUrl(value: string | undefined): string {
    return parseConnectionUrl(value, {
        protocols: ["redis:", "rediss:"],
        missingMessage: "REDIS_URL is required for this runtime role",
        invalidMessage: "REDIS_URL must be a valid redis:// or rediss:// URL",
    });
}
