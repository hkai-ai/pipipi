import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createProcessingApplication } from "../src/api/application.js";
import type { CallerIdentityResolver } from "../src/api/identity.js";
import { createAsyncProcessRuns } from "../src/process-runs/index.js";
import { createInMemoryProcessWorkQueue } from "../src/process-runs/queue/index.js";
import { createInMemoryProcessRunStore } from "../src/process-runs/store/index.js";
import {
    createProcessWorker,
    createProcessWorkerDrain,
} from "../src/process-runs/worker/index.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    defineProcessRegistration,
    failProcess,
} from "../src/process-runtime/index.js";

const runningApplications: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
    await Promise.all(
        runningApplications.splice(0).map((application) => application.close()),
    );
});

describe("Async Process Runs HTTP Interface", () => {
    it("keeps async routes disabled while preserving readiness and sync execution", async () => {
        const application = createProcessingApplication({
            executor: {
                execute: async () => ({
                    runId: RUN_ID,
                    process: "test-processing",
                    version: "v1",
                    status: "succeeded",
                    output: { value: "sync" },
                }),
            },
            http: { logSink: () => {} },
        });
        runningApplications.push(application);
        const { url } = await application.listen();

        const disabledSubmit = await fetch(`${url}/process-runs`, {
            method: "POST",
        });
        const disabledFind = await fetch(`${url}/process-runs/${RUN_ID}`);
        const readiness = await fetch(`${url}/readyz`);
        const sync = await fetch(`${url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });

        expect(disabledSubmit.status).toBe(404);
        expect(disabledFind.status).toBe(404);
        expect(readiness.status).toBe(200);
        expect(await readiness.json()).toEqual({ status: "ready" });
        expect(sync.status).toBe(200);
        expect(await sync.json()).toMatchObject({ status: "succeeded" });
    });

    it("uses runId as the only public Process Run identifier", async () => {
        const fixture = await startFixture();

        const submission = await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "request-1",
        });

        expect(submission.status).toBe(202);
        expect(submission.headers.get("location")).toBe(
            `/process-runs/${RUN_ID}`,
        );
        expect(submission.headers.get("retry-after")).toBe("2");
        expect(submission.headers.get("cache-control")).toBe("no-store");
        const accepted = await submission.json();
        expect(accepted).toEqual({
            runId: RUN_ID,
            process: "test-processing",
            version: "v1",
            status: "queued",
            createdAt: "2026-08-09T10:00:00.000Z",
        });
        expect(accepted).not.toHaveProperty("taskId");
        expect(accepted).not.toHaveProperty("jobId");

        const query = await find(fixture.url, RUN_ID, "caller-a");
        expect(query.status).toBe(200);
        expect(query.headers.get("retry-after")).toBe("2");
        expect(query.headers.get("cache-control")).toBe("no-store");
        expect(await query.json()).toMatchObject({
            runId: RUN_ID,
            status: "queued",
        });
    });

    it("does not reveal a run to another authenticated caller", async () => {
        const fixture = await startFixture();
        await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "request-1",
        });

        const unauthorized = await find(fixture.url, RUN_ID, "caller-b");
        const unknown = await find(fixture.url, UNKNOWN_RUN_ID, "caller-b");
        expect(unauthorized.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(await unauthorized.json()).toEqual(await unknown.json());
    });

    it("requires both trusted identity and a bounded Idempotency-Key", async () => {
        const fixture = await startFixture();

        const missingIdentity = await fetch(`${fixture.url}/process-runs`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": "request-1",
            },
            body: JSON.stringify(validRequest()),
        });
        const missingKey = await fetch(`${fixture.url}/process-runs`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-test-caller": "caller-a",
            },
            body: JSON.stringify(validRequest()),
        });
        const oversizedKey = await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "x".repeat(513),
        });

        expect(missingIdentity.status).toBe(401);
        expect(await missingIdentity.json()).toMatchObject({
            error: { code: "CALLER_UNAUTHORIZED" },
        });
        expect(missingKey.status).toBe(400);
        expect(await missingKey.json()).toMatchObject({
            error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
        });
        expect(oversizedKey.status).toBe(400);
        expect(await oversizedKey.json()).toMatchObject({
            error: { code: "INVALID_IDEMPOTENCY_KEY" },
        });
        await expect(fixture.queue.take()).resolves.toBeUndefined();
    });

    it("maps acceptance rejection without creating a run or queue item", async () => {
        const fixture = await startFixture();

        const invalid = await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "invalid",
            request: {
                process: "test-processing",
                version: "v1",
                input: { value: 42 },
            },
        });
        const missing = await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "missing",
            request: {
                process: "missing",
                version: "v1",
                input: { value: "request" },
            },
        });

        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({
            error: { code: "INVALID_INPUT" },
        });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({
            error: { code: "PROCESS_NOT_FOUND" },
        });
        await expect(fixture.queue.take()).resolves.toBeUndefined();
        await expect(
            fixture.store.findOwned(RUN_ID, "caller-a"),
        ).resolves.toBeUndefined();
    });

    it("replays the same resource and rejects inconsistent key reuse", async () => {
        const fixture = await startFixture();
        const first = await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "shared",
        });
        const firstBody = await first.json();
        const replay = await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "shared",
        });
        const conflict = await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "shared",
            request: {
                process: "test-processing",
                version: "v1",
                input: { value: "different" },
            },
        });

        expect(replay.status).toBe(202);
        expect(await replay.json()).toEqual(firstBody);
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({
            error: { code: "IDEMPOTENCY_CONFLICT" },
        });
        await expect(fixture.queue.take()).resolves.toEqual({
            schemaVersion: 1,
            runId: RUN_ID,
        });
        await expect(fixture.queue.take()).resolves.toBeUndefined();
    });

    it("returns a runId that resolves to the completed Business Process result", async () => {
        const fixture = await startFixture();
        const submission = await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "request-1",
        });
        const accepted = (await submission.json()) as { runId: string };
        const queued = await find(fixture.url, accepted.runId, "caller-a");
        expect(await queued.json()).toMatchObject({
            runId: accepted.runId,
            status: "queued",
        });

        await expect(fixture.drain.drainOne()).resolves.toBe("processed");

        const response = await find(fixture.url, accepted.runId, "caller-a");
        expect(response.status).toBe(200);
        expect(response.headers.get("retry-after")).toBeNull();
        expect(await response.json()).toEqual({
            runId: accepted.runId,
            process: "test-processing",
            version: "v1",
            status: "succeeded",
            createdAt: "2026-08-09T10:00:00.000Z",
            startedAt: "2026-08-09T10:00:01.000Z",
            finishedAt: "2026-08-09T10:00:02.000Z",
            output: { value: "processed:request" },
        });
    });

    it("returns a stable public error for a failed Process Run", async () => {
        const fixture = await startFixture();
        const submission = await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "request-1",
            request: {
                process: "test-processing",
                version: "v1",
                input: { value: "fail-dependency" },
            },
        });
        const accepted = (await submission.json()) as { runId: string };
        const queued = await find(fixture.url, accepted.runId, "caller-a");
        expect(await queued.json()).toMatchObject({
            runId: accepted.runId,
            status: "queued",
        });

        await expect(fixture.drain.drainOne()).resolves.toBe("processed");

        const response = await find(fixture.url, accepted.runId, "caller-a");
        expect(response.status).toBe(200);
        expect(response.headers.get("retry-after")).toBeNull();
        expect(await response.json()).toEqual({
            runId: accepted.runId,
            process: "test-processing",
            version: "v1",
            status: "failed",
            createdAt: "2026-08-09T10:00:00.000Z",
            startedAt: "2026-08-09T10:00:01.000Z",
            finishedAt: "2026-08-09T10:00:02.000Z",
            error: {
                code: "DEPENDENCY_FAILURE",
                message: "A required business service is unavailable",
            },
        });
    });

    it("separates liveness from dependency readiness", async () => {
        const readiness = vi.fn<() => Promise<void>>().mockResolvedValue();
        const fixture = await startFixture({ readiness });

        const health = await fetch(`${fixture.url}/healthz`);
        expect(health.status).toBe(200);
        expect(readiness).not.toHaveBeenCalled();
        const ready = await fetch(`${fixture.url}/readyz`);
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({ status: "ready" });
        expect(readiness).toHaveBeenCalledTimes(1);

        readiness.mockRejectedValueOnce(new Error("database unavailable"));
        const notReady = await fetch(`${fixture.url}/readyz`);
        expect(notReady.status).toBe(503);
        expect(await notReady.json()).toEqual({ status: "not_ready" });
    });

    it("sanitizes unexpected submission failures as retryable transport errors", async () => {
        const sensitiveFailure = "postgres password secret-value";
        const application = createProcessingApplication({
            executor: unusedExecutor(),
            http: {
                logSink: () => {},
                asyncProcessRuns: {
                    runs: {
                        submit: async () => {
                            throw new Error(sensitiveFailure);
                        },
                        find: async () => undefined,
                    },
                    callerIdentity: fakeCallerIdentity,
                    readiness: async () => {},
                },
            },
        });
        runningApplications.push(application);
        const { url } = await application.listen();

        const response = await submit(url, {
            callerId: "caller-a",
            idempotencyKey: "request-1",
        });
        const body = await response.json();
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("2");
        expect(body).toMatchObject({
            error: { code: "ASYNC_SERVICE_UNAVAILABLE" },
        });
        expect(JSON.stringify(body)).not.toContain(sensitiveFailure);
    });

    it.each([
        {
            scope: "caller" as const,
            httpStatus: 429,
            errorCode: "CALLER_BACKLOG_LIMIT_REACHED" as const,
        },
        {
            scope: "global" as const,
            httpStatus: 503,
            errorCode: "ASYNC_SERVICE_CAPACITY_REACHED" as const,
        },
    ])(
        "maps $scope backlog admission without disabling existing Run queries",
        async ({ scope, httpStatus, errorCode }) => {
            const logs: unknown[] = [];
            const application = createProcessingApplication({
                executor: unusedExecutor(),
                http: {
                    logSink: (record) => logs.push(record),
                    asyncProcessRuns: {
                        runs: {
                            submit: async () => ({
                                accepted: false,
                                error: {
                                    code: errorCode,
                                    message:
                                        scope === "caller"
                                            ? "Caller Process Run backlog limit reached"
                                            : "Async Process Run capacity is temporarily unavailable",
                                    retryAfterSeconds: 17,
                                },
                            }),
                            find: async (runId) => ({
                                runId,
                                process: "test-processing",
                                version: "v1",
                                status: "queued",
                                createdAt: "2026-08-09T10:00:00.000Z",
                            }),
                        },
                        callerIdentity: fakeCallerIdentity,
                        readiness: async () => {},
                    },
                },
            });
            runningApplications.push(application);
            const { url } = await application.listen();

            const response = await submit(url, {
                callerId: "caller-a",
                idempotencyKey: "request-1",
            });
            expect(response.status).toBe(httpStatus);
            expect(response.headers.get("retry-after")).toBe("17");
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(await response.json()).toMatchObject({
                error: { code: errorCode },
            });

            const query = await find(url, RUN_ID, "caller-a");
            expect(query.status).toBe(200);
            expect(await query.json()).toMatchObject({
                runId: RUN_ID,
                status: "queued",
            });
            expect(logs).toContainEqual(
                expect.objectContaining({
                    event: "process_run_admission_rejected",
                    scope,
                    httpStatus,
                    retryAfterSeconds: 17,
                }),
            );
        },
    );

    it("logs async acceptance and observation without request or result content", async () => {
        const logs: unknown[] = [];
        const fixture = await startFixture({
            logSink: (record) => logs.push(record),
        });

        await submit(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "request-1",
            request: {
                process: "test-processing",
                version: "v1",
                input: { value: "must-not-appear-in-logs" },
            },
        });
        await find(fixture.url, RUN_ID, "caller-a");

        expect(logs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    event: "process_run_submission_accepted",
                    runId: RUN_ID,
                    process: "test-processing",
                    version: "v1",
                }),
                expect.objectContaining({
                    event: "process_run_observed",
                    runId: RUN_ID,
                    status: "queued",
                }),
            ]),
        );
        expect(JSON.stringify(logs)).not.toContain("must-not-appear-in-logs");
        expect(JSON.stringify(logs)).not.toContain("request-1");
    });
});

async function startFixture(
    options: {
        readiness?: () => Promise<void>;
        logSink?: NonNullable<
            Parameters<typeof createProcessingApplication>[0]["http"]
        >["logSink"];
    } = {},
) {
    const registration = defineProcessRegistration({
        id: "test-processing",
        version: "v1",
        inputSchema: z.strictObject({ value: z.string() }),
        outputSchema: z.strictObject({ value: z.string() }),
        execute: async (input) =>
            input.value === "fail-dependency"
                ? failProcess(
                      "DEPENDENCY_FAILURE",
                      "A required business service is unavailable",
                  )
                : { value: `processed:${input.value}` },
    });
    const store = createInMemoryProcessRunStore({ maxRuns: 10 });
    const queue = createInMemoryProcessWorkQueue({ maxJobs: 10 });
    const registry = createProcessRegistry([registration]);
    const runs = createAsyncProcessRuns({
        registry,
        store,
        queue,
        clock: () => "2026-08-09T10:00:00.000Z",
        createRunId: () => RUN_ID,
    });
    const workerTimes = [
        "2026-08-09T10:00:01.000Z",
        "2026-08-09T10:00:02.000Z",
    ];
    const worker = createProcessWorker({
        registry,
        store,
        attemptRunner: createProcessAttemptRunner(),
        clock: () => {
            const time = workerTimes.shift();
            if (!time) throw new Error("Fixture clock exhausted");
            return time;
        },
        createClaimToken: () => CLAIM_TOKEN,
    });
    const application = createProcessingApplication({
        executor: unusedExecutor(),
        http: {
            logSink: options.logSink ?? (() => {}),
            asyncProcessRuns: {
                runs,
                callerIdentity: fakeCallerIdentity,
                readiness: options.readiness ?? (async () => {}),
            },
        },
    });
    runningApplications.push(application);
    const { url } = await application.listen();
    return {
        url,
        store,
        queue,
        drain: createProcessWorkerDrain({ source: queue, worker }),
    };
}

function submit(
    url: string,
    options: {
        callerId: string;
        idempotencyKey: string;
        request?: unknown;
    },
): Promise<Response> {
    return fetch(`${url}/process-runs`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "idempotency-key": options.idempotencyKey,
            "x-test-caller": options.callerId,
        },
        body: JSON.stringify(options.request ?? validRequest()),
    });
}

function find(url: string, runId: string, callerId: string): Promise<Response> {
    return fetch(`${url}/process-runs/${runId}`, {
        headers: { "x-test-caller": callerId },
    });
}

function validRequest() {
    return {
        process: "test-processing",
        version: "v1",
        input: { value: "request" },
    };
}

function unusedExecutor() {
    return {
        execute: async () => ({
            runId: UNKNOWN_RUN_ID,
            process: "test-processing",
            version: "v1",
            status: "succeeded" as const,
            output: { value: "unused" },
        }),
    };
}

const fakeCallerIdentity: CallerIdentityResolver = {
    resolve: async (headers) => {
        const callerId = headers["x-test-caller"];
        return typeof callerId === "string" ? { callerId } : undefined;
    },
};

const RUN_ID = "00000000-0000-4000-8000-000000000101";
const UNKNOWN_RUN_ID = "00000000-0000-4000-8000-000000000999";
const CLAIM_TOKEN = "10000000-0000-4000-8000-000000000101";
