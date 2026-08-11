import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessingApplication } from "../src/api/application.js";
import { constructProcessingService } from "../src/app/api.js";
import type { ProcessRunRecord } from "../src/process-runtime/records.js";

const runningApplications: ProcessingApplication[] = [];
const runningServers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        runningApplications.splice(0).map((application) => application.close()),
    );
    await Promise.all(
        runningServers.splice(0).map(
            (server) =>
                new Promise<void>((resolve, reject) => {
                    server.close((error) =>
                        error ? reject(error) : resolve(),
                    );
                }),
        ),
    );
});

describe("operator console construction", () => {
    it("records an executed run and serves it from the console", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-console-"));
        const businessApi = await startBusinessApi();
        const url = await startService({
            BUSINESS_API_BASE_URL: businessApi,
            PROCESS_RUN_RECORD_DIRECTORY: directory,
            PROCESS_RUN_RECORD_CONTENT: "accepted-input-and-output",
            CONSOLE_ENABLED: "true",
        });

        const execution = await fetch(`${url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                process: "content-processing",
                version: "v1",
                input: { content: "整理这段内容" },
            }),
        });
        expect(execution.status).toBe(200);
        const { runId } = (await execution.json()) as { runId: string };

        const record = await waitForRecord(url, runId);
        expect(record.process).toBe("content-processing");
        expect(record.status).toBe("succeeded");
        expect(record.content?.input).toEqual({ content: "整理这段内容" });
        expect(record.content?.output).toEqual({ content: "processed" });

        const page = (await (await fetch(`${url}/console/runs`)).json()) as {
            records: readonly ProcessRunRecord[];
        };
        expect(page.records.map((entry) => entry.runId)).toEqual([runId]);
    });

    it("serves the Attempt timeline of an executed run", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-console-"));
        const businessApi = await startBusinessApi();
        const url = await startService({
            BUSINESS_API_BASE_URL: businessApi,
            PROCESS_RUN_RECORD_DIRECTORY: directory,
            PROCESS_RUN_RECORD_CONTENT: "accepted-input-and-output",
            CONSOLE_ENABLED: "true",
        });

        const execution = await fetch(`${url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                process: "content-processing",
                version: "v1",
                input: { content: "整理这段内容" },
            }),
        });
        const { runId } = (await execution.json()) as { runId: string };
        const timeline = await waitForTimeline(url, runId);

        expect(timeline.runId).toBe(runId);
        expect(timeline.activities.map((entry) => entry.event)).toEqual([
            "process_run_attempt_started",
            "process_run_activity_started",
            "process_run_activity_finished",
            "process_run_attempt_finished",
        ]);
        expect(timeline.activities[1]?.activity).toBe("content_processing");
        expect(timeline.activities.at(-1)?.durationMs).toBeGreaterThanOrEqual(
            0,
        );
    });

    it("returns an empty timeline for an unknown run", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-console-"));
        const url = await startService({
            PROCESS_RUN_RECORD_DIRECTORY: directory,
            CONSOLE_ENABLED: "true",
        });

        const response = await fetch(
            `${url}/console/runs/does-not-exist/activities`,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            runId: "does-not-exist",
            activities: [],
        });
    });

    it("keeps recording off and the console unmounted by default", async () => {
        const url = await startService({});

        expect((await fetch(`${url}/console`)).status).toBe(404);
    });

    it("refuses to enable the console without a durable record directory", () => {
        expect(() =>
            constructProcessingService({
                BUSINESS_API_BASE_URL: "https://business.example",
                CONSOLE_ENABLED: "true",
            }),
        ).toThrow(/PROCESS_RUN_RECORD_DIRECTORY/);
    });

    it("refuses a base path that would shadow a service route", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-console-"));

        expect(() =>
            constructProcessingService({
                BUSINESS_API_BASE_URL: "https://business.example",
                PROCESS_RUN_RECORD_DIRECTORY: directory,
                CONSOLE_ENABLED: "true",
                CONSOLE_BASE_PATH: "/execute",
            }),
        ).toThrow(/CONSOLE_BASE_PATH/);
    });
});

async function startService(
    environment: Record<string, string>,
): Promise<string> {
    const constructed = constructProcessingService({
        BUSINESS_API_BASE_URL: "https://business.example",
        ...environment,
    });
    runningApplications.push(constructed.application);
    const { url } = await constructed.application.listen();
    return url;
}

async function startBusinessApi(): Promise<string> {
    const server = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ content: "processed" }));
        });
    });
    runningServers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected an IP address for the stub Business API");
    }
    return `http://127.0.0.1:${address.port}`;
}

type ConsoleTimeline = Readonly<{
    runId: string;
    activities: readonly Readonly<{
        event: string;
        activity?: string;
        outcome?: string;
        durationMs?: number;
    }>[];
}>;

/**
 * The Run Record and the activity records are two independent best-effort
 * writes, so the record can be readable while the closing activity line is
 * still settling. Wait for the Attempt to be reported as finished rather than
 * assuming one write implies the other.
 */
async function waitForTimeline(
    url: string,
    runId: string,
): Promise<ConsoleTimeline> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const response = await fetch(`${url}/console/runs/${runId}/activities`);
        if (response.ok) {
            const timeline = (await response.json()) as ConsoleTimeline;
            if (
                timeline.activities.some(
                    (entry) => entry.event === "process_run_attempt_finished",
                )
            ) {
                return timeline;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Attempt timeline for ${runId} never finished`);
}

/**
 * Recording is best effort and deliberately off the response path, so a record
 * can land just after `/execute` returns.
 */
async function waitForRecord(
    url: string,
    runId: string,
): Promise<ProcessRunRecord> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const response = await fetch(`${url}/console/runs/${runId}`);
        if (response.ok) return (await response.json()) as ProcessRunRecord;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Run Record for ${runId} was never written`);
}
