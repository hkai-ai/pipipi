import {
    createServer,
    type RequestListener,
    type Server,
    type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessingApplication } from "../src/api/application.js";
import { constructProcessingService } from "../src/app/api.js";
import { createProductionRuntime } from "../src/app/business-processes.js";
import { PiPosterAgent } from "../src/processes/poster/agent.pi.js";

type RunningServer = {
    url: string;
    close: () => Promise<void>;
};

const runningApplications: ProcessingApplication[] = [];
const runningServers: RunningServer[] = [];

afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(
        runningApplications.splice(0).map((application) => application.close()),
    );
    await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

describe("Startup Construction", () => {
    it("registers minimal-zine-poster/v1 in the production catalog", () => {
        const runtime = createProductionRuntime({
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
        });

        const registration = runtime.registry.find({
            id: "minimal-zine-poster",
            version: "v1",
        });

        expect(registration?.identity).toEqual({
            id: "minimal-zine-poster",
            version: "v1",
        });
        expect(
            registration?.accept({
                brief: "A quiet rainy bookstore",
                text: "PIPIPI ZINE",
            }),
        ).toMatchObject({ accepted: true });
    });

    it("registers crt-interface-image/v1 in the production catalog", () => {
        const runtime = createProductionRuntime({
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
        });

        const registration = runtime.registry.find({
            id: "crt-interface-image",
            version: "v1",
        });

        expect(registration?.identity).toEqual({
            id: "crt-interface-image",
            version: "v1",
        });
        expect(
            registration?.accept({
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            }),
        ).toMatchObject({ accepted: true });
    });

    it("constructs the default service from an explicit environment", async () => {
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "  https://images.example/base  ",
        });
        expect(constructed.port).toBe(3000);

        runningApplications.push(constructed.application);
        const { url } = await constructed.application.listen();

        const healthResponse = await fetch(`${url}/healthz`);
        expect(healthResponse.status).toBe(200);

        const executeResponse = await fetch(`${url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                process: "minimal-zine-poster",
                version: "v1",
                input: {},
            }),
        });
        expect(executeResponse.status).toBe(400);
        expect(await executeResponse.json()).toMatchObject({
            process: "minimal-zine-poster",
            version: "v1",
            status: "failed",
            error: { code: "INVALID_INPUT" },
        });
    });

    it("uses the 30000-millisecond Process Runner timeout by default", async () => {
        const compile = holdPosterCompile();
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://images.example",
        });
        runningApplications.push(constructed.application);
        const { url } = await constructed.application.listen();
        useControllableAbortTimeouts();
        vi.useFakeTimers();

        let responseSettled = false;
        const responsePromise = executePosterProcess(url).then((response) => {
            responseSettled = true;
            return response;
        });
        await compile.started;

        try {
            await vi.advanceTimersByTimeAsync(29_999);
            expect(responseSettled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);

            const response = await responsePromise;
            expect(response.status).toBe(504);
            expect(await response.json()).toMatchObject({
                status: "failed",
                error: { code: "PROCESS_TIMEOUT" },
            });
        } finally {
            compile.release();
        }
    });

    it("uses the 262144-byte HTTP request-body limit by default", async () => {
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://images.example",
        });
        runningApplications.push(constructed.application);
        const { url } = await constructed.application.listen();

        const boundaryResponse = await fetch(`${url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: executeRequestBodyWithBytes(262_144),
        });
        const oversizedResponse = await fetch(`${url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: executeRequestBodyWithBytes(262_145),
        });

        // The boundary body passes the transport limit and reaches the
        // Process input Schema, which rejects a brief this long.
        expect(boundaryResponse.status).toBe(400);
        expect(oversizedResponse.status).toBe(413);
    });

    it("uses four concurrent executions as the default capacity", async () => {
        const compile = holdPosterCompile(4);
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://images.example",
        });
        runningApplications.push(constructed.application);
        const { url } = await constructed.application.listen();

        const admittedResponses = Array.from({ length: 4 }, () =>
            executePosterProcess(url),
        );
        await compile.started;

        try {
            const capacityResponse = await executePosterProcess(url);
            expect(capacityResponse.status).toBe(503);
            expect(compile.calls()).toBe(4);
        } finally {
            compile.release();
        }

        for (const response of await Promise.all(admittedResponses)) {
            expect(response.status).not.toBe(503);
        }
    });

    it("returns an explicitly configured listen port", () => {
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
            PORT: "4100",
        });

        expect(constructed.port).toBe(4100);
    });

    it.each(["", "0", "65536", "-1", "1.5", "not-a-number"])(
        "rejects invalid listen port %j before listening",
        (port) => {
            expect(() =>
                constructProcessingService({
                    CRT_BUSINESS_API_BASE_URL: "https://business.example",
                    PORT: port,
                }),
            ).toThrow("PORT must be an integer between 1 and 65535");
        },
    );

    it("applies the configured Process Runner timeout", async () => {
        const compile = holdPosterCompile();
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://images.example",
            PROCESS_TIMEOUT_MS: "20",
        });
        runningApplications.push(constructed.application);
        const { url } = await constructed.application.listen();

        try {
            const response = await executePosterProcess(url);

            expect(response.status).toBe(504);
            expect(await response.json()).toMatchObject({
                status: "failed",
                error: {
                    code: "PROCESS_TIMEOUT",
                    message: "流程超过执行时限，请核对步骤耗时和下游请求状态",
                },
            });
        } finally {
            compile.release();
        }
    });

    it("rejects an unknown Process Run log level before listening", () => {
        expect(() =>
            constructProcessingService({
                CRT_BUSINESS_API_BASE_URL: "https://business.example",
                PROCESS_RUN_LOG_LEVEL: "verbose",
            }),
        ).toThrow(
            "PROCESS_RUN_LOG_LEVEL must be fatal, error, warn, info, debug, trace, or silent",
        );
    });

    it("keeps Agent-backed health checks isolated from external dependencies", async () => {
        const externalRequests: string[] = [];
        const externalSentinel = await startServer((request, response) => {
            externalRequests.push(request.url ?? "");
            response.writeHead(500).end();
        });
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: externalSentinel.url,
            PI_PROVIDER: "openai",
            PI_MODEL: "gpt-5.6-terra",
            PI_AGENT_DIR: "/must-not-be-read/pi-agent",
            OPENAI_BASE_URL: `${externalSentinel.url}/v1`,
            OPENAI_API_MODE: "responses",
            OPENAI_API_KEY: "must-not-be-read",
        });
        runningApplications.push(constructed.application);
        const { url } = await constructed.application.listen();

        const response = await fetch(`${url}/healthz`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "ok" });
        expect(externalRequests).toEqual([]);
    });

    it.each([{ PI_PROVIDER: "openai" }, { PI_MODEL: "gpt-5.6-terra" }])(
        "rejects an incomplete Agent model override %j",
        (agentEnvironment) => {
            expect(() =>
                constructProcessingService({
                    CRT_BUSINESS_API_BASE_URL: "https://business.example",
                    ...agentEnvironment,
                }),
            ).toThrow("Pi provider and model must be configured together");
        },
    );

    it("rejects an unknown OpenAI API mode used by an Agent process", () => {
        expect(() =>
            constructProcessingService({
                CRT_BUSINESS_API_BASE_URL: "https://business.example",
                OPENAI_API_MODE: "legacy-completions",
            }),
        ).toThrow("OPENAI_API_MODE must be responses or chat-completions");
    });

    it("preserves compatible-gateway validation for Agent processes", () => {
        expect(() =>
            constructProcessingService({
                CRT_BUSINESS_API_BASE_URL: "https://business.example",
                OPENAI_BASE_URL: "https://gateway.example/v1",
            }),
        ).toThrow(
            "OpenAI Chat Completions mode requires PI_PROVIDER=openai and PI_MODEL",
        );
    });

    it("accepts explicit Agent overrides without contacting the provider", () => {
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
            PI_PROVIDER: "openai",
            PI_MODEL: "gpt-5.6-terra",
            PI_AGENT_DIR: "/tmp/pi-agent",
            OPENAI_BASE_URL: "https://gateway.example/v1",
            OPENAI_API_MODE: "responses",
        });

        expect(constructed.port).toBe(3000);
    });

    it("rejects an unavailable installed Runtime Skill before listening", () => {
        expect(() =>
            constructProcessingService({
                CRT_BUSINESS_API_BASE_URL: "https://business.example",
                PI_POSTER_SKILL_DIRECTORY: "/missing/poster-prompt",
            }),
        ).toThrow(
            'Runtime Skill "minimal-zine-poster-prompt" must resolve exactly once',
        );
    });

    it("ships composed-task/v1 switched off and only registers it when enabled", () => {
        const off = createProductionRuntime({
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
        });
        const on = createProductionRuntime({
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
            COMPOSED_TASK_ENABLED: "true",
        });
        const identity = { id: "composed-task", version: "v1" };

        expect(off.registry.find(identity)).toBeUndefined();
        expect(off.registry.list()).toHaveLength(20);
        const registration = on.registry.find(identity);
        expect(registration?.identity).toEqual(identity);
        expect(registration?.timeoutMs).toBe(600_000);
        expect(
            registration?.accept({
                goal: "Make a poster from this copy",
                material: { copy: "Quiet rain over the bookstore" },
            }),
        ).toMatchObject({ accepted: true });
        expect(
            registration?.accept({
                goal: "Refine",
                skills: ["anything"],
            }),
        ).toEqual({ accepted: false });
        expect(on.registry.list()).toHaveLength(21);
    });

    it("validates the Planner Skill only when composed-task/v1 is enabled", () => {
        const environment = {
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
            PI_COMPOSED_SKILL_DIRECTORY: "/missing/composed-planner",
        };

        expect(() => constructProcessingService(environment)).not.toThrow();
        expect(() =>
            constructProcessingService({
                ...environment,
                COMPOSED_TASK_ENABLED: "true",
            }),
        ).toThrow(
            'Runtime Skill "composed-task-planner" must resolve exactly once',
        );
        expect(() =>
            constructProcessingService({
                ...environment,
                COMPOSED_TASK_ENABLED: "yes",
            }),
        ).toThrow("COMPOSED_TASK_ENABLED must be true or false");
    });

    it("requires an OpenAI credential for a production Agent deployment", () => {
        const environment = {
            NODE_ENV: "production",
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
            PI_PROVIDER: "openai",
            PI_MODEL: "gpt-5.6-terra",
        };

        expect(() => constructProcessingService(environment)).toThrow(
            "Deployment environment for api is missing required variables: OPENAI_API_KEY",
        );
        expect(
            constructProcessingService({
                ...environment,
                OPENAI_API_KEY: "deployment-test-key",
            }).port,
        ).toBe(3000);
    });

    it("applies the configured HTTP request-body limit", async () => {
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
            HTTP_MAX_REQUEST_BODY_BYTES: "80",
        });
        runningApplications.push(constructed.application);
        const { url } = await constructed.application.listen();

        const response = await fetch(`${url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                process: "minimal-zine-poster",
                version: "v1",
                input: { brief: "x".repeat(100) },
            }),
        });

        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({
            status: "failed",
            error: {
                code: "REQUEST_TOO_LARGE",
                message: "Request body exceeds the configured limit",
            },
        });
    });

    it("applies the configured concurrent-execution limit", async () => {
        const compile = holdPosterCompile();
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://images.example",
            MAX_CONCURRENT_EXECUTIONS: "1",
        });
        runningApplications.push(constructed.application);
        const { url } = await constructed.application.listen();

        const firstResponsePromise = executePosterProcess(url);
        await compile.started;

        try {
            const secondResponse = await executePosterProcess(url);

            expect(secondResponse.status).toBe(503);
            expect(secondResponse.headers.get("retry-after")).toBe("1");
            expect(await secondResponse.json()).toEqual({
                status: "failed",
                error: {
                    code: "SERVICE_BUSY",
                    message: "Service is at capacity",
                },
            });
        } finally {
            compile.release();
        }

        expect((await firstResponsePromise).status).not.toBe(503);
    });

    it.each([undefined, "", "   "])(
        "requires the image Business API URL for environment value %j",
        (baseUrl) => {
            expect(() =>
                constructProcessingService({
                    CRT_BUSINESS_API_BASE_URL: baseUrl,
                }),
            ).toThrow(
                "Deployment environment for api is missing required variables: CRT_BUSINESS_API_BASE_URL",
            );
        },
    );

    it.each([
        ["CRT_BUSINESS_API_BASE_URL", "not-a-url-with-secret-value"],
        ["CRT_BUSINESS_API_BASE_URL", "file:///private/business-api"],
        [
            "CRT_BUSINESS_API_BASE_URL",
            "https://user:secret-value@business.example",
        ],
    ])("rejects unsafe %s %j without echoing it", (name, baseUrl) => {
        let error: unknown;
        try {
            constructProcessingService({
                CRT_BUSINESS_API_BASE_URL: "https://images.example",
                [name]: baseUrl,
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
            `${name} must be a valid HTTP(S) URL without credentials`,
        );
        expect((error as Error).message).not.toContain(baseUrl);
        expect((error as Error).message).not.toContain("secret-value");
    });

    it.each(["1", "65535"])("accepts listen-port boundary %j", (port) => {
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
            PORT: port,
        });

        expect(constructed.port).toBe(Number(port));
    });

    it.each([
        "POSTER_API_TIMEOUT_MS",
        "CRT_API_TIMEOUT_MS",
        "PROCESS_TIMEOUT_MS",
        "HTTP_MAX_REQUEST_BODY_BYTES",
        "MAX_CONCURRENT_EXECUTIONS",
    ])("rejects invalid positive-integer values for %s", (name) => {
        for (const value of ["", "0", "-1", "1.5", "not-a-number"]) {
            expect(() =>
                constructProcessingService({
                    CRT_BUSINESS_API_BASE_URL: "https://business.example",
                    [name]: value,
                }),
            ).toThrow(`${name} must be a positive integer`);
        }
    });

    it("keeps invalid async-only configuration inert while the feature is off", () => {
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
            ASYNC_PROCESS_RUNS_ENABLED: "false",
            DATABASE_URL: "not-a-database-url",
            ASYNC_GATEWAY_SHARED_SECRET: "short",
            PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS: "invalid",
        });

        expect(constructed.port).toBe(3000);
    });

    it.each(["", "TRUE", "yes", "0"])(
        "rejects unknown async feature flag %j",
        (value) => {
            expect(() =>
                constructProcessingService({
                    CRT_BUSINESS_API_BASE_URL: "https://business.example",
                    ASYNC_PROCESS_RUNS_ENABLED: value,
                }),
            ).toThrow("ASYNC_PROCESS_RUNS_ENABLED must be true or false");
        },
    );

    it.each(["", "TRUE", "yes", "0"])(
        "rejects unknown internal evaluation flag %j",
        (value) => {
            expect(() =>
                constructProcessingService({
                    CRT_BUSINESS_API_BASE_URL: "https://business.example",
                    INTERNAL_EVAL_ENABLED: value,
                }),
            ).toThrow("INTERNAL_EVAL_ENABLED must be true or false");
        },
    );

    it.each([
        ["DATABASE_URL", "DATABASE_URL"],
        ["ASYNC_GATEWAY_SHARED_SECRET", "ASYNC_GATEWAY_SHARED_SECRET"],
        [
            "PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS",
            "PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS",
        ],
        ["PROCESS_RUN_RESULT_RETENTION_MS", "PROCESS_RUN_RESULT_RETENTION_MS"],
        [
            "PROCESS_RUN_METADATA_RETENTION_MS",
            "PROCESS_RUN_METADATA_RETENTION_MS",
        ],
        ["ASYNC_RELEASE_STAGE", "ASYNC_RELEASE_STAGE"],
        ["ASYNC_GLOBAL_BACKLOG_LIMIT", "ASYNC_GLOBAL_BACKLOG_LIMIT"],
        ["ASYNC_CALLER_BACKLOG_LIMIT", "ASYNC_CALLER_BACKLOG_LIMIT"],
        [
            "ASYNC_BACKLOG_RETRY_AFTER_SECONDS",
            "ASYNC_BACKLOG_RETRY_AFTER_SECONDS",
        ],
    ])("requires %s when Async Process Runs are enabled", (key, label) => {
        expect(() =>
            constructProcessingService(asyncEnvironment({ [key]: undefined })),
        ).toThrow(
            `Deployment environment for api is missing required variables: ${label}`,
        );
    });

    it("rejects an invalid PostgreSQL URL without echoing credentials", () => {
        const databaseUrl = "https://user:secret-value@database.example/db";
        let error: unknown;
        try {
            constructProcessingService(
                asyncEnvironment({ DATABASE_URL: databaseUrl }),
            );
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
            "DATABASE_URL must be a valid PostgreSQL connection URL",
        );
        expect((error as Error).message).not.toContain("secret-value");
    });

    it("rejects a weak gateway shared secret", () => {
        expect(() =>
            constructProcessingService(
                asyncEnvironment({ ASYNC_GATEWAY_SHARED_SECRET: "too-short" }),
            ),
        ).toThrow("ASYNC_GATEWAY_SHARED_SECRET must be at least 32 bytes");
    });

    it.each([
        "PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS",
        "PROCESS_RUN_RESULT_RETENTION_MS",
        "PROCESS_RUN_METADATA_RETENTION_MS",
        "ASYNC_POSTGRES_POOL_MAX",
        "ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS",
        "PROCESS_RUN_CLAIM_LEASE_MS",
        "ASYNC_RETRY_AFTER_SECONDS",
        "ASYNC_GLOBAL_BACKLOG_LIMIT",
        "ASYNC_CALLER_BACKLOG_LIMIT",
        "ASYNC_BACKLOG_RETRY_AFTER_SECONDS",
        "ASYNC_STUCK_RUN_AGE_MS",
        "ASYNC_MAX_OUTBOX_LAG_MS",
        "ASYNC_RECOVERY_MAX_AGE_MS",
    ])("rejects invalid async positive-integer values for %s", (name) => {
        expect(() =>
            constructProcessingService(asyncEnvironment({ [name]: "0" })),
        ).toThrow(`${name} must be a positive integer`);
    });

    it("rejects a negative staged-release stuck Run threshold", () => {
        expect(() =>
            constructProcessingService(
                asyncEnvironment({ ASYNC_MAX_STUCK_RUNS: "-1" }),
            ),
        ).toThrow("ASYNC_MAX_STUCK_RUNS must be a non-negative integer");
    });

    it("requires an explicit rollout stage and coherent admission limits", () => {
        expect(() =>
            constructProcessingService(
                asyncEnvironment({ ASYNC_RELEASE_STAGE: "preview" }),
            ),
        ).toThrow(
            "ASYNC_RELEASE_STAGE must be internal, canary, or production",
        );
        expect(() =>
            constructProcessingService(
                asyncEnvironment({
                    ASYNC_GLOBAL_BACKLOG_LIMIT: "10",
                    ASYNC_CALLER_BACKLOG_LIMIT: "11",
                }),
            ),
        ).toThrow(
            "ASYNC_CALLER_BACKLOG_LIMIT must not exceed ASYNC_GLOBAL_BACKLOG_LIMIT",
        );
    });

    it("keeps liveness independent when the async database is unreachable", async () => {
        const constructed = constructProcessingService(
            asyncEnvironment({
                DATABASE_URL: "postgres://service:secret@127.0.0.1:1/pipipi",
                ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS: "10",
            }),
        );
        runningApplications.push(constructed.application);
        const { url } = await constructed.application.listen();

        const response = await fetch(`${url}/healthz`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "ok" });
    });
});

function asyncEnvironment(
    overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
    return {
        CRT_BUSINESS_API_BASE_URL: "https://business.example",
        ASYNC_PROCESS_RUNS_ENABLED: "true",
        DATABASE_URL: "postgres://service:secret@database.example/pipipi",
        ASYNC_GATEWAY_SHARED_SECRET: "gateway-secret-that-is-at-least-32-bytes",
        PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS: "86400000",
        PROCESS_RUN_RESULT_RETENTION_MS: "604800000",
        PROCESS_RUN_METADATA_RETENTION_MS: "2592000000",
        ASYNC_RELEASE_STAGE: "internal",
        ASYNC_GLOBAL_BACKLOG_LIMIT: "1000",
        ASYNC_CALLER_BACKLOG_LIMIT: "100",
        ASYNC_BACKLOG_RETRY_AFTER_SECONDS: "5",
        ...overrides,
    };
}

function executePosterProcess(url: string): Promise<Response> {
    return fetch(`${url}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief: "Startup review" },
        }),
    });
}

/**
 * Holds the poster Agent's compile step so a production Process stays in
 * flight without a model; released calls fail instead of rendering.
 */
function holdPosterCompile(startedAfter = 1): {
    started: Promise<void>;
    release: () => void;
    calls: () => number;
} {
    const started = deferred<void>();
    const released = deferred<void>();
    let calls = 0;
    vi.spyOn(PiPosterAgent.prototype, "compile").mockImplementation(
        async () => {
            calls += 1;
            if (calls === startedAfter) started.resolve();
            await released.promise;
            throw new Error("Released test compile");
        },
    );
    return {
        started: started.promise,
        release: () => released.resolve(),
        calls: () => calls,
    };
}

function executeRequestBodyWithBytes(byteLength: number): string {
    const createBody = (brief: string) =>
        JSON.stringify({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief },
        });
    const emptyBody = createBody("");
    const briefByteLength = byteLength - Buffer.byteLength(emptyBody);
    if (briefByteLength < 1) {
        throw new Error("Requested test body is too small");
    }
    const body = createBody("x".repeat(briefByteLength));
    if (Buffer.byteLength(body) !== byteLength) {
        throw new Error("Could not construct the requested test body size");
    }
    return body;
}

function useControllableAbortTimeouts(): void {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), delay);
        return controller.signal;
    });
}

async function startServer(listener: RequestListener): Promise<RunningServer> {
    const server = createServer(listener);
    const url = await listen(server);
    const runningServer = { url, close: () => close(server) };
    runningServers.push(runningServer);
    return runningServer;
}

async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected test server to listen on an IP address");
    }
    return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}
