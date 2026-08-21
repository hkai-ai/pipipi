/** 为后台 Role 组装健康检查、就绪探测的 HTTP Runtime，并管理其生命周期 */
import { createServer, type Server, type ServerResponse } from "node:http";

export type RuntimeRoleName =
    | "process-dispatcher"
    | "process-worker"
    | "webhook-worker"
    | "retention-cleaner";

export type BackgroundRuntime = Readonly<{
    start: () => Promise<void>;
    ready: () => Promise<void>;
    close: () => Promise<void>;
}>;

export type RuntimeRoleApplication = Readonly<{
    listen: (options?: {
        host?: string;
        port?: number;
    }) => Promise<{ url: string }>;
    close: () => Promise<void>;
}>;

export type ConstructedRuntimeRoleService = Readonly<{
    application: RuntimeRoleApplication;
    port: number;
}>;

export function createRuntimeRoleApplication(options: {
    role: RuntimeRoleName;
    runtime: BackgroundRuntime;
    readinessTimeoutMs?: number;
}): RuntimeRoleApplication {
    const readinessTimeoutMs = positiveInteger(
        options.readinessTimeoutMs ?? 2_000,
        "Runtime role readiness timeout",
    );
    const server = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/healthz") {
            writeJson(response, 200, { status: "ok", role: options.role });
            return;
        }
        if (request.method === "GET" && request.url === "/readyz") {
            void readiness(options.runtime.ready, readinessTimeoutMs).then(
                (ready) =>
                    writeJson(
                        response,
                        ready ? 200 : 503,
                        ready
                            ? { status: "ready", role: options.role }
                            : { status: "not_ready", role: options.role },
                    ),
            );
            return;
        }
        writeJson(response, 404, {
            error: { code: "NOT_FOUND", message: "Route not found" },
        });
    });
    let started = false;
    let closed = false;

    return Object.freeze({
        listen: async (listenOptions) => {
            if (closed) throw new Error("Runtime role application is closed");
            if (started)
                throw new Error("Runtime role application already started");
            started = true;
            await options.runtime.start();
            return { url: await listen(server, listenOptions) };
        },
        close: async () => {
            if (closed) return;
            closed = true;
            try {
                await closeServer(server);
            } finally {
                await options.runtime.close();
            }
        },
    });
}

export function constructRuntimeRoleService(options: {
    role: RuntimeRoleName;
    runtime: BackgroundRuntime;
    port: number;
    readinessTimeoutMs: number;
}): ConstructedRuntimeRoleService {
    return Object.freeze({
        application: createRuntimeRoleApplication({
            role: options.role,
            runtime: options.runtime,
            readinessTimeoutMs: options.readinessTimeoutMs,
        }),
        port: options.port,
    });
}

async function readiness(
    check: () => Promise<void>,
    timeoutMs: number,
): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            check(),
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("Readiness check timed out")),
                    timeoutMs,
                );
            }),
        ]);
        return true;
    } catch {
        return false;
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function listen(
    server: Server,
    options: { host?: string; port?: number } = {},
): Promise<string> {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected the runtime role to listen on an IP address");
    }
    return `http://${host}:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

function writeJson(
    response: ServerResponse,
    status: number,
    body: unknown,
): void {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}
