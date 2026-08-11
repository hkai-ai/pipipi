import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
    type ConsoleHttpOptions,
    createProcessingRequestListener,
} from "../src/api/http.js";
import type {
    ProcessExecutor,
    ProcessRunLogRecord,
} from "../src/process-runtime/index.js";
import type { ProcessRunRecord } from "../src/process-runtime/records.js";

type RunningService = { url: string; close: () => Promise<void> };

const runningServices: RunningService[] = [];

afterEach(async () => {
    await Promise.all(
        runningServices.splice(0).map((service) => service.close()),
    );
});

const storedRecord: ProcessRunRecord = {
    schemaVersion: 1,
    recordedAt: "2026-08-11T10:00:00.000Z",
    runId: "00000000-0000-4000-8000-000000000001",
    process: "news-image-pale-watercolor",
    version: "v1",
    status: "succeeded",
};

const storedActivity: ProcessRunLogRecord = {
    schemaVersion: 1,
    timestamp: "2026-08-11T10:00:00.000Z",
    runId: "run-1",
    process: "news-image-pale-watercolor",
    version: "v1",
    attemptNumber: 1,
    sequence: 1,
    event: "process_run_attempt_started",
};

const emptySummary = {
    since: "2026-08-11T00:00:00.000Z",
    totals: { succeeded: 0, failed: 0 },
    byProcess: [],
    byErrorCode: [],
    attemptDurationMs: { samples: 0 },
} as const;

describe("operator console HTTP boundary", () => {
    it("serves the console document at the configured base path", async () => {
        const service = await startConsole();

        const response = await fetch(`${service.url}/console`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
            "text/html; charset=utf-8",
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        expect(await response.text()).toContain("Business Process 控制台");
    });

    it("serves the console from an unguessable base path only", async () => {
        const service = await startConsole({ basePath: "/ops-7f3a" });

        expect((await fetch(`${service.url}/ops-7f3a`)).status).toBe(200);
        expect((await fetch(`${service.url}/console`)).status).toBe(404);
    });

    it("lists Run Records and passes paging through", async () => {
        const queries: unknown[] = [];
        const service = await startConsole({
            list: async (query) => {
                queries.push(query);
                return { records: [storedRecord], nextBefore: "2026-08-11" };
            },
        });

        const response = await fetch(
            `${service.url}/console/runs?limit=2&before=2026-08-12`,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            records: [storedRecord],
            nextBefore: "2026-08-11",
        });
        expect(queries).toEqual([{ limit: 2, before: "2026-08-12" }]);
    });

    it("rejects a limit that is not a positive integer", async () => {
        const service = await startConsole();

        const response = await fetch(`${service.url}/console/runs?limit=zero`);

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            status: "failed",
            error: {
                code: "INVALID_INPUT",
                message: "limit must be a positive integer",
            },
        });
    });

    it("reports a missing Run Record without leaking storage detail", async () => {
        const service = await startConsole({ find: async () => undefined });

        const response = await fetch(`${service.url}/console/runs/missing-run`);

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            status: "failed",
            error: {
                code: "PROCESS_RUN_RECORD_NOT_FOUND",
                message: "Process Run Record not found",
            },
        });
    });

    it("serves an Attempt timeline for a run", async () => {
        const requested: string[] = [];
        const service = await startConsole({
            findActivities: async (runId) => {
                requested.push(runId);
                return [storedActivity];
            },
        });

        const response = await fetch(
            `${service.url}/console/runs/run-1/activities`,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            runId: "run-1",
            activities: [storedActivity],
        });
        expect(requested).toEqual(["run-1"]);
    });

    it("does not mistake a deeper path for a run id", async () => {
        const service = await startConsole();

        expect(
            (await fetch(`${service.url}/console/runs/a/b/activities`)).status,
        ).toBe(404);
        expect((await fetch(`${service.url}/console/runs/a/b`)).status).toBe(
            404,
        );
    });

    it("omits the timeline route when activities are not configured", async () => {
        const service = await startRequestListener(
            createProcessingRequestListener(rejectingExecutor(), {
                console: {
                    basePath: "/console",
                    records: {
                        list: async () => ({ records: [storedRecord] }),
                        find: async () => storedRecord,
                    },
                },
            }),
        );

        const response = await fetch(
            `${service.url}/console/runs/run-1/activities`,
        );

        expect(response.status).toBe(404);
    });

    it("serves the production catalog", async () => {
        const service = await startConsole({
            processes: [
                {
                    process: "news-image-pale-watercolor",
                    version: "v1",
                    activities: ["news_image_rendering"],
                    retry: { maximumAttempts: 1, retryableErrorCodes: [] },
                    input: { type: "object" },
                    output: { type: "object" },
                },
            ],
        });

        const response = await fetch(`${service.url}/console/processes`);

        expect(response.status).toBe(200);
        expect(
            ((await response.json()) as { processes: unknown[] }).processes,
        ).toHaveLength(1);
    });

    it("omits the catalog route when the catalog is not configured", async () => {
        const service = await startRequestListener(
            createProcessingRequestListener(rejectingExecutor(), {
                console: {
                    basePath: "/console",
                    records: {
                        list: async () => ({ records: [storedRecord] }),
                        find: async () => storedRecord,
                    },
                },
            }),
        );

        expect((await fetch(`${service.url}/console/processes`)).status).toBe(
            404,
        );
    });

    it("adds live concurrency to the stored summary", async () => {
        const service = await startConsole({
            summarise: async ({ since }) => ({ ...emptySummary, since }),
        });

        const response = await fetch(`${service.url}/console/stats`);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            totals: { succeeded: 0, failed: 0 },
            concurrency: { active: 0, limit: 4 },
        });
    });

    it("derives the window start from the requested hours", async () => {
        const windows: string[] = [];
        const service = await startConsole({
            summarise: async ({ since }) => {
                windows.push(since);
                return { ...emptySummary, since };
            },
        });

        const before = Date.now();
        await fetch(`${service.url}/console/stats?hours=6`);
        const since = new Date(windows[0] as string).getTime();

        expect(before - since).toBeGreaterThanOrEqual(6 * 3_600_000 - 5_000);
        expect(before - since).toBeLessThanOrEqual(6 * 3_600_000 + 5_000);
    });

    it("rejects a window outside the supported range", async () => {
        const service = await startConsole({
            summarise: async ({ since }) => ({ ...emptySummary, since }),
        });

        for (const hours of ["0", "721", "abc"]) {
            const response = await fetch(
                `${service.url}/console/stats?hours=${hours}`,
            );
            expect(response.status, `hours=${hours}`).toBe(400);
        }
    });

    it("omits the stats route when statistics are not configured", async () => {
        const service = await startRequestListener(
            createProcessingRequestListener(rejectingExecutor(), {
                console: {
                    basePath: "/console",
                    records: {
                        list: async () => ({ records: [storedRecord] }),
                        find: async () => storedRecord,
                    },
                },
            }),
        );

        expect((await fetch(`${service.url}/console/stats`)).status).toBe(404);
    });

    it("never executes a Business Process from a console route", async () => {
        let executions = 0;
        const service = await startConsole({
            executor: {
                execute: async () => {
                    executions += 1;
                    throw new Error("unexpected execution");
                },
            },
        });

        await fetch(`${service.url}/console`);
        await fetch(`${service.url}/console/runs`);

        expect(executions).toBe(0);
    });

    it("leaves business routes untouched when the console is not configured", async () => {
        const service = await startRequestListener(
            createProcessingRequestListener(rejectingExecutor()),
        );

        const response = await fetch(`${service.url}/console`);

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            status: "failed",
            error: { code: "ROUTE_NOT_FOUND", message: "Route not found" },
        });
    });
});

async function startConsole(
    options: {
        basePath?: string;
        list?: ConsoleHttpOptions["records"]["list"];
        find?: ConsoleHttpOptions["records"]["find"];
        findActivities?: NonNullable<
            ConsoleHttpOptions["activities"]
        >["findByRun"];
        processes?: ConsoleHttpOptions["processes"];
        summarise?: NonNullable<ConsoleHttpOptions["stats"]>["summarise"];
        executor?: ProcessExecutor;
    } = {},
): Promise<RunningService> {
    return startRequestListener(
        createProcessingRequestListener(
            options.executor ?? rejectingExecutor(),
            {
                console: {
                    basePath: options.basePath ?? "/console",
                    records: {
                        list:
                            options.list ??
                            (async () => ({ records: [storedRecord] })),
                        find: options.find ?? (async () => storedRecord),
                    },
                    activities: {
                        findByRun:
                            options.findActivities ??
                            (async () => [storedActivity]),
                    },
                    ...(options.processes
                        ? { processes: options.processes }
                        : {}),
                    ...(options.summarise
                        ? { stats: { summarise: options.summarise } }
                        : {}),
                },
            },
        ),
    );
}

function rejectingExecutor(): ProcessExecutor {
    return {
        execute: async () => {
            throw new Error("The console must not execute a Business Process");
        },
    };
}

async function startRequestListener(
    listener: RequestListener,
): Promise<RunningService> {
    const server = createServer(listener);
    const url = await listen(server);
    const service = { url, close: () => close(server) };
    runningServices.push(service);
    return service;
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
        throw new Error("Expected an IP address for test server");
    }
    return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}
