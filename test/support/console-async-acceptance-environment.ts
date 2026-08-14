import { mkdtemp, rm } from "node:fs/promises";
import {
    createServer as createHttpServer,
    type IncomingMessage,
    type Server,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Redis } from "ioredis";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { createServer as createViteServer } from "vite";
import { createDevelopmentGateway } from "../../console/development-gateway.js";
import { constructProcessingService } from "../../src/app/api.js";
import { constructProcessDispatcherService } from "../../src/app/process-dispatcher.js";
import { constructProcessWorkerService } from "../../src/app/process-worker.js";

export type ConsoleAsyncAcceptanceEnvironment = Readonly<{
    url: string;
    effectCount: (content: string) => number;
    startWorker: () => Promise<void>;
    close: () => Promise<void>;
}>;

/**
 * Starts the exact public browser path against isolated durable infrastructure.
 * The free local Business Capability records effects but makes no provider call.
 */
export async function startConsoleAsyncAcceptanceEnvironment(
    options: Readonly<{
        databaseUrl: string;
        redisUrl: string;
        assetDirectory?: string;
    }>,
): Promise<ConsoleAsyncAcceptanceEnvironment> {
    assertTestDatabase(options.databaseUrl);
    assertTestRedis(options.redisUrl);
    await resetInfrastructure(options.databaseUrl, options.redisUrl);

    const closeResources: (() => Promise<void>)[] = [];
    try {
        const records = await mkdtemp(
            path.join(tmpdir(), "pipipi-console-acceptance-"),
        );
        closeResources.push(() =>
            rm(records, { recursive: true, force: true }),
        );

        const businessApi = await startFreeBusinessApi();
        closeResources.push(businessApi.close);

        const gatewaySecret =
            "browser-acceptance-gateway-secret-at-least-32-bytes";
        const sharedEnvironment = {
            DATABASE_URL: options.databaseUrl,
            REDIS_URL: options.redisUrl,
            PROCESS_QUEUE_PREFIX: "pipipi-console-browser-acceptance",
            PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS: "86400000",
            PROCESS_RUN_RESULT_RETENTION_MS: "604800000",
            PROCESS_RUN_METADATA_RETENTION_MS: "2592000000",
            PROCESS_TIMEOUT_MS: "2000",
            PROCESS_RUN_CLAIM_LEASE_MS: "5000",
            ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS: "500",
            ASYNC_REDIS_CONNECTION_TIMEOUT_MS: "500",
            RUNTIME_ROLE_READINESS_TIMEOUT_MS: "1000",
        } as const;
        const api = constructProcessingService({
            ...sharedEnvironment,
            BUSINESS_API_BASE_URL: businessApi.url,
            ASYNC_PROCESS_RUNS_ENABLED: "true",
            ASYNC_GATEWAY_SHARED_SECRET: gatewaySecret,
            ASYNC_RELEASE_STAGE: "internal",
            ASYNC_GLOBAL_BACKLOG_LIMIT: "1000",
            ASYNC_CALLER_BACKLOG_LIMIT: "100",
            ASYNC_BACKLOG_RETRY_AFTER_SECONDS: "5",
            ASYNC_RETRY_AFTER_SECONDS: "1",
            PROCESS_RUN_RECORD_STORE: "file",
            PROCESS_RUN_RECORD_DIRECTORY: records,
            PROCESS_RUN_RECORD_CONTENT: "accepted-input-and-output",
            CONSOLE_ENABLED: "true",
            CONSOLE_BASE_PATH: "/console",
            CONSOLE_ASSET_DIRECTORY:
                options.assetDirectory ?? path.resolve("dist/console"),
        });
        closeResources.push(api.application.close);
        const dispatcher = constructProcessDispatcherService({
            DATABASE_URL: options.databaseUrl,
            REDIS_URL: options.redisUrl,
            PROCESS_QUEUE_PREFIX: sharedEnvironment.PROCESS_QUEUE_PREFIX,
            ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS: "500",
            ASYNC_REDIS_CONNECTION_TIMEOUT_MS: "500",
            RUNTIME_ROLE_READINESS_TIMEOUT_MS: "1000",
            OUTBOX_DISPATCH_INTERVAL_MS: "10",
            PROCESS_RUN_RECONCILE_INTERVAL_MS: "20",
            PROCESS_RUN_RECONCILE_QUEUED_AGE_MS: "20",
        });
        closeResources.push(dispatcher.application.close);
        const worker = constructProcessWorkerService({
            ...sharedEnvironment,
            BUSINESS_API_BASE_URL: businessApi.url,
            BUSINESS_API_TIMEOUT_MS: "500",
            PROCESS_RUN_RECORD_STORE: "file",
            PROCESS_RUN_RECORD_DIRECTORY: records,
            PROCESS_RUN_RECORD_CONTENT: "accepted-input-and-output",
            PROCESS_WORKER_CONCURRENCY: "1",
            PROCESS_WORKER_SHUTDOWN_GRACE_MS: "1000",
        });
        closeResources.push(worker.application.close);

        const [apiListening, dispatcherListening] = await Promise.all([
            api.application.listen(),
            dispatcher.application.listen(),
        ]);
        await Promise.all([
            waitForHttpStatus(`${apiListening.url}/readyz`, 200),
            waitForHttpStatus(`${dispatcherListening.url}/readyz`, 200),
        ]);

        const processRunProxy = createDevelopmentGateway({
            command: "serve",
            mode: "development",
            environment: {
                CONSOLE_DEVELOPMENT_GATEWAY_ENABLED: "true",
                CONSOLE_DEVELOPMENT_GATEWAY_TARGET: apiListening.url,
                ASYNC_GATEWAY_SHARED_SECRET: gatewaySecret,
            },
        });
        if (!processRunProxy) {
            throw new Error("Expected the Console development Gateway");
        }
        const gateway = await createViteServer({
            appType: "custom",
            configFile: false,
            logLevel: "silent",
            server: {
                host: "127.0.0.1",
                port: 0,
                proxy: {
                    "/process-runs": processRunProxy,
                    "/": { target: apiListening.url },
                },
            },
        });
        closeResources.push(() => gateway.close());
        await gateway.listen();

        let hasWorkerStarted = false;
        return Object.freeze({
            url: httpServerUrl(gateway.httpServer),
            effectCount: businessApi.effectCount,
            startWorker: async () => {
                if (hasWorkerStarted) return;
                hasWorkerStarted = true;
                const listening = await worker.application.listen();
                await waitForHttpStatus(`${listening.url}/readyz`, 200);
            },
            close: () => closeAcceptanceResources(closeResources),
        });
    } catch (error) {
        try {
            await closeAcceptanceResources(closeResources);
        } catch (cleanupFailure) {
            throw new AggregateError(
                [error, cleanupFailure],
                "Console browser acceptance startup and cleanup failed",
            );
        }
        throw error;
    }
}

async function closeAcceptanceResources(
    resources: readonly (() => Promise<void>)[],
): Promise<void> {
    const results = await Promise.allSettled(
        Array.from(resources)
            .reverse()
            .map((close) => close()),
    );
    const failures = results.filter(
        (result): result is PromiseRejectedResult =>
            result.status === "rejected",
    );
    if (failures.length > 0) {
        throw new AggregateError(
            failures.map((failure) => failure.reason),
            "Console browser acceptance cleanup failed",
        );
    }
}

async function resetInfrastructure(
    databaseUrl: string,
    redisUrl: string,
): Promise<void> {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
        await pool.query("DROP SCHEMA public CASCADE");
        await pool.query("CREATE SCHEMA public");
        await runner({
            databaseUrl,
            direction: "up",
            dir: path.resolve("migrations"),
            migrationsTable: "pgmigrations",
            count: Infinity,
            advisoryLockMode: "wait",
            log: () => {},
        });
        await redis.flushdb();
    } finally {
        await Promise.allSettled([pool.end(), redis.quit()]);
    }
}

async function startFreeBusinessApi(): Promise<{
    url: string;
    close: () => Promise<void>;
    effectCount: (content: string) => number;
}> {
    const effects = new Map<string, number>();
    const server = createHttpServer((request, response) => {
        void respondToBusinessRequest(request, response, effects);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        url: httpServerUrl(server),
        close: () => closeHttpServer(server),
        effectCount: (content) => effects.get(content) ?? 0,
    };
}

async function respondToBusinessRequest(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
    effects: Map<string, number>,
): Promise<void> {
    if (request.method !== "POST" || request.url !== "/process") {
        response.writeHead(404).end();
        return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        content: string;
    };
    effects.set(body.content, (effects.get(body.content) ?? 0) + 1);
    if (body.content === "browser failure") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "simulated dependency failure" }));
        return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ content: `Processed: ${body.content}` }));
}

async function waitForHttpStatus(url: string, status: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(url)).status === status) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${url} did not return ${status}`);
}

async function closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}

function httpServerUrl(
    server: { address(): ReturnType<Server["address"]> } | null,
): string {
    const address = server?.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected an HTTP server address");
    }
    return `http://127.0.0.1:${address.port}`;
}

function assertTestDatabase(url: string): void {
    if (!new URL(url).pathname.slice(1).endsWith("_test")) {
        throw new Error(
            "Console acceptance requires a database name ending in _test",
        );
    }
}

function assertTestRedis(value: string): void {
    const url = new URL(value);
    const database = Number(url.pathname.slice(1));
    if (
        url.protocol !== "redis:" ||
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        !Number.isInteger(database) ||
        database < 1
    ) {
        throw new Error(
            "Console acceptance requires a local Redis URL with a non-zero database",
        );
    }
}
