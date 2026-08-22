import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    type ConsoleHttpOptions,
    type ConsoleSkillCatalog,
    type ConsoleSkillDescription,
    createProcessingRequestListener,
} from "../src/api/http.js";
import type {
    ProcessExecutor,
    ProcessRunLogRecord,
} from "../src/process-runtime/index.js";
import type { ProcessRunRecord } from "../src/process-runtime/records.js";

type RunningService = { url: string; close: () => Promise<void> };

/**
 * A stand-in for the build output, so the serving contract can be tested
 * without first running the console build.
 */
let builtConsoleDirectory = "";

beforeAll(async () => {
    builtConsoleDirectory = await mkdtemp(join(tmpdir(), "pipipi-console-"));
    await mkdir(join(builtConsoleDirectory, "assets"));
    await writeFile(
        join(builtConsoleDirectory, "index.html"),
        '<!doctype html>\n<html>\n<head>\n<title>Business Process 控制台</title>\n</head>\n<body><div id="console"></div><script type="module" src="./assets/index-abc123.js"></script></body>\n</html>\n',
        "utf8",
    );
    await writeFile(
        join(builtConsoleDirectory, "assets", "index-abc123.js"),
        "export const built = true;\n",
        "utf8",
    );
});

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
    byDay: [],
    recentFailures: [],
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

    it("binds protected Console responses to the deployed revision", async () => {
        const revision = "a".repeat(40);
        const service = await startConsole({ revision });

        for (const path of ["/console", "/console/runs?limit=1"]) {
            const response = await fetch(`${service.url}${path}`);
            expect(response.headers.get("x-pipipi-revision")).toBe(revision);
        }
    });

    it("resolves assets against the deployed base path", async () => {
        const service = await startConsole({ basePath: "/ops-7f3a" });

        const document = await (await fetch(`${service.url}/ops-7f3a`)).text();

        expect(document).toContain('<base href="/ops-7f3a/">');
    });

    it("serves the document with or without a trailing slash", async () => {
        const service = await startConsole();

        expect((await fetch(`${service.url}/console`)).status).toBe(200);
        expect((await fetch(`${service.url}/console/`)).status).toBe(200);
    });

    it("serves a built asset as an immutable file", async () => {
        const service = await startConsole();

        const response = await fetch(
            `${service.url}/console/assets/index-abc123.js`,
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
            "text/javascript; charset=utf-8",
        );
        expect(response.headers.get("cache-control")).toContain("immutable");
    });

    it("refuses to serve anything outside the asset directory", async () => {
        const service = await startConsole();

        for (const name of [
            "../index.html",
            "..%2Findex.html",
            "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
            "sub/dir.js",
            "index-abc123.txt",
            "unknown-asset.js",
        ]) {
            const response = await fetch(
                `${service.url}/console/assets/${name}`,
            );
            expect(response.status, name).toBe(404);
        }
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

    it("passes all history filters through with canonical timestamps", async () => {
        const queries: unknown[] = [];
        const service = await startConsole({
            list: async (query) => {
                queries.push(query);
                return { records: [] };
            },
        });

        const response = await fetch(
            `${service.url}/console/runs?process=crt-interface-image&status=failed&errorCode=AGENT_FAILURE&since=2026-08-11T10%3A00%3A00%2B08%3A00&until=2026-08-12T10%3A00%3A00%2B08%3A00`,
        );

        expect(response.status).toBe(200);
        expect(queries).toEqual([
            {
                process: "crt-interface-image",
                status: "failed",
                errorCode: "AGENT_FAILURE",
                since: "2026-08-11T02:00:00.000Z",
                until: "2026-08-12T02:00:00.000Z",
            },
        ]);
    });

    it.each([
        ["since=not-a-time", "since must be an ISO 8601 timestamp"],
        [
            "since=2026-08-12T00%3A00%3A00Z&until=2026-08-11T00%3A00%3A00Z",
            "since must be earlier than until",
        ],
        ["errorCode=bad%20code", "errorCode has an invalid format"],
    ])("rejects invalid history filters: %s", async (query, message) => {
        const service = await startConsole();

        const response = await fetch(`${service.url}/console/runs?${query}`);

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            status: "failed",
            error: { code: "INVALID_INPUT", message },
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
                    assetDirectory: builtConsoleDirectory,
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
                    assetDirectory: builtConsoleDirectory,
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

    it("serves the installed Skill catalog", async () => {
        const service = await startConsole({ skills: stubSkillCatalog() });

        const response = await fetch(`${service.url}/console/skills`);

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({
            skills: [stubSkill],
        });
    });

    it("serves a Skill cover by exact identity and revalidates by ETag", async () => {
        const service = await startConsole({ skills: stubSkillCatalog() });
        const url = `${service.url}/console/skills/${encodeURIComponent("news-image-pale-watercolor-prompt@v1")}/cover`;

        const response = await fetch(url);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(Buffer.from(await response.arrayBuffer())).toEqual(coverBytes);
        const etag = response.headers.get("etag");
        expect(etag).toBe('"0123456789abcdef0123456789abcdef"');

        const revalidation = await fetch(url, {
            headers: { "if-none-match": etag as string },
        });
        expect(revalidation.status).toBe(304);
    });

    it("reports a missing or malformed Skill cover without reaching the catalog", async () => {
        const requested: string[] = [];
        const service = await startConsole({
            skills: stubSkillCatalog((name, version) => {
                requested.push(`${name}@${version}`);
            }),
        });

        const missing = await fetch(
            `${service.url}/console/skills/content-integrity@v1/cover`,
        );
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({
            status: "failed",
            error: {
                code: "SKILL_COVER_NOT_FOUND",
                message: "Runtime Skill cover not found",
            },
        });

        for (const path of [
            "/console/skills/../../etc/passwd/cover",
            "/console/skills/Bad_Name@v1/cover",
            "/console/skills/content-integrity@latest/cover",
            "/console/skills/content-integrity/cover",
            "/console/skills/content-integrity@v1/other",
            "/console/skills/content-integrity@v1/cover/extra",
        ]) {
            const response = await fetch(`${service.url}${path}`);
            expect(response.status, path).toBe(404);
        }
        expect(requested).toEqual(["content-integrity@v1"]);
    });

    it("omits the Skill routes when the catalog is not configured", async () => {
        const service = await startRequestListener(
            createProcessingRequestListener(rejectingExecutor(), {
                console: {
                    basePath: "/console",
                    assetDirectory: builtConsoleDirectory,
                    records: {
                        list: async () => ({ records: [storedRecord] }),
                        find: async () => storedRecord,
                    },
                },
            }),
        );

        expect((await fetch(`${service.url}/console/skills`)).status).toBe(404);
        expect(
            (
                await fetch(
                    `${service.url}/console/skills/content-integrity@v1/cover`,
                )
            ).status,
        ).toBe(404);
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
                    assetDirectory: builtConsoleDirectory,
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

const coverBytes = Buffer.from("\x89PNG\r\n\x1a\nstub", "binary");

const stubSkill: ConsoleSkillDescription = {
    name: "news-image-pale-watercolor-prompt",
    version: "v1",
    sha256: "a".repeat(64),
    description: "Compile factual news into a pale-watercolor prompt.",
    processes: ["news-image-pale-watercolor"],
    instructions: "# Pale watercolor news image\n\nCompile only.",
    files: ["SKILL.md", "SOURCE.md", "cover.png"],
    cover: { file: "cover.png", mediaType: "image/png" },
    source: "# Source",
};

function stubSkillCatalog(
    onCover?: (name: string, version: string) => void,
): ConsoleSkillCatalog {
    return {
        list: () => [stubSkill],
        readCover: async (name, version) => {
            onCover?.(name, version);
            if (name !== stubSkill.name || version !== stubSkill.version) {
                return undefined;
            }
            return {
                mediaType: "image/png",
                contents: coverBytes,
                etag: '"0123456789abcdef0123456789abcdef"',
            };
        },
    };
}

async function startConsole(
    options: {
        basePath?: string;
        list?: ConsoleHttpOptions["records"]["list"];
        find?: ConsoleHttpOptions["records"]["find"];
        findActivities?: NonNullable<
            ConsoleHttpOptions["activities"]
        >["findByRun"];
        processes?: ConsoleHttpOptions["processes"];
        skills?: ConsoleHttpOptions["skills"];
        summarise?: NonNullable<ConsoleHttpOptions["stats"]>["summarise"];
        revision?: string;
        executor?: ProcessExecutor;
    } = {},
): Promise<RunningService> {
    return startRequestListener(
        createProcessingRequestListener(
            options.executor ?? rejectingExecutor(),
            {
                console: {
                    basePath: options.basePath ?? "/console",
                    ...(options.revision ? { revision: options.revision } : {}),
                    assetDirectory: builtConsoleDirectory,
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
                    ...(options.skills ? { skills: options.skills } : {}),
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
