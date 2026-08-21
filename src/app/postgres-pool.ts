import { Pool } from "pg";
import { parsePositiveInteger, type StartupEnvironment } from "./config.js";

export function createRuntimePool(options: {
    environment: StartupEnvironment;
    connectionString: string;
    applicationName: string;
}): Pool {
    const pool = new Pool({
        connectionString: options.connectionString,
        max: parsePositiveInteger(
            options.environment.ASYNC_POSTGRES_POOL_MAX,
            10,
            "ASYNC_POSTGRES_POOL_MAX",
        ),
        connectionTimeoutMillis: parsePositiveInteger(
            options.environment.ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS,
            5_000,
            "ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS",
        ),
        application_name: options.applicationName,
    });
    pool.on("error", () => {
        console.error(
            JSON.stringify({
                event: "postgres_pool_error",
                role: options.applicationName,
                timestamp: new Date().toISOString(),
            }),
        );
    });
    return pool;
}
