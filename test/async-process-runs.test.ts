import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAsyncProcessRuns } from "../src/process-runs/index.js";
import { createInMemoryProcessWorkQueue } from "../src/process-runs/queue/index.js";
import {
    createInMemoryProcessRunStore,
    ProcessRunBacklogLimitError,
} from "../src/process-runs/store/index.js";
import {
    createProcessWorker,
    createProcessWorkerDrain,
} from "../src/process-runs/worker/index.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../src/processes/runtime/index.js";

describe("Async Process Runs", () => {
    it("moves an accepted run through queued, running, and succeeded", async () => {
        let releaseExecution: (() => void) | undefined;
        let markExecutionStarted: (() => void) | undefined;
        const executionStarted = new Promise<void>((resolve) => {
            markExecutionStarted = resolve;
        });
        const executionRelease = new Promise<void>((resolve) => {
            releaseExecution = resolve;
        });
        const process = registration("v1", async (value) => {
            markExecutionStarted?.();
            await executionRelease;
            return { value: value.toUpperCase() };
        });
        const fixture = createFixture([process]);

        const submission = await fixture.runs.submit(request("v1", "request"), {
            callerId: "caller-a",
            idempotencyKey: "request-1",
        });
        expect(submission).toEqual({
            accepted: true,
            runId: RUN_IDS[0],
            process: "test-processing",
            version: "v1",
            status: "queued",
            createdAt: "2026-08-09T10:00:00.000Z",
        });
        expect(await fixture.runs.find(RUN_IDS[0], caller("caller-a"))).toEqual(
            {
                runId: RUN_IDS[0],
                process: "test-processing",
                version: "v1",
                status: "queued",
                createdAt: "2026-08-09T10:00:00.000Z",
            },
        );

        const draining = fixture.drain.drainOne();
        await executionStarted;
        expect(await fixture.runs.find(RUN_IDS[0], caller("caller-a"))).toEqual(
            {
                runId: RUN_IDS[0],
                process: "test-processing",
                version: "v1",
                status: "running",
                createdAt: "2026-08-09T10:00:00.000Z",
                startedAt: "2026-08-09T10:00:01.000Z",
            },
        );

        releaseExecution?.();
        await expect(draining).resolves.toBe("processed");
        expect(await fixture.runs.find(RUN_IDS[0], caller("caller-a"))).toEqual(
            {
                runId: RUN_IDS[0],
                process: "test-processing",
                version: "v1",
                status: "succeeded",
                createdAt: "2026-08-09T10:00:00.000Z",
                startedAt: "2026-08-09T10:00:01.000Z",
                finishedAt: "2026-08-09T10:00:02.000Z",
                output: { value: "REQUEST" },
            },
        );
    });

    it("persists a sanitized Business Process failure", async () => {
        const process = defineProcessRegistration({
            id: "test-processing",
            version: "v1",
            inputSchema: z.strictObject({ value: z.string() }),
            outputSchema: z.strictObject({ value: z.string() }),
            execute: async () =>
                failProcess(
                    "DEPENDENCY_FAILURE",
                    "The dependency is unavailable",
                ),
        });
        const fixture = createFixture([process]);
        await fixture.runs.submit(request("v1", "request"), {
            callerId: "caller-a",
            idempotencyKey: "request-1",
        });

        await expect(fixture.drain.drainOne()).resolves.toBe("processed");
        expect(await fixture.runs.find(RUN_IDS[0], caller("caller-a"))).toEqual(
            {
                runId: RUN_IDS[0],
                process: "test-processing",
                version: "v1",
                status: "failed",
                createdAt: "2026-08-09T10:00:00.000Z",
                startedAt: "2026-08-09T10:00:01.000Z",
                finishedAt: "2026-08-09T10:00:02.000Z",
                error: {
                    code: "DEPENDENCY_FAILURE",
                    message: "The dependency is unavailable",
                },
            },
        );
    });

    it("retries only a declared transient failure and keeps one public terminal state", async () => {
        const seenRunIds: string[] = [];
        let attempts = 0;
        const process = defineProcessRegistration({
            id: "test-processing",
            version: "v1",
            inputSchema: z.strictObject({ value: z.string() }),
            outputSchema: z.strictObject({ value: z.string() }),
            retryPolicy: {
                maximumAttempts: 3,
                retryableErrorCodes: ["DEPENDENCY_FAILURE"],
                backoff: { initialDelayMs: 100, maximumDelayMs: 400 },
            },
            execute: async (input, context) => {
                seenRunIds.push(context.runId);
                attempts += 1;
                return attempts === 1
                    ? failProcess(
                          "DEPENDENCY_FAILURE",
                          "A required business service is unavailable",
                      )
                    : { value: input.value.toUpperCase() };
            },
        });
        const fixture = createFixture([process]);
        await fixture.runs.submit(request("v1", "request"), {
            callerId: "caller-a",
            idempotencyKey: "retry-safe",
        });

        await expect(fixture.drain.drainOne()).resolves.toEqual({
            outcome: "retry-scheduled",
            delayMs: 100,
        });
        await expect(
            fixture.runs.find(RUN_IDS[0], caller("caller-a")),
        ).resolves.toMatchObject({ status: "queued" });

        await expect(
            fixture.worker.process({ schemaVersion: 1, runId: RUN_IDS[0] }),
        ).resolves.toBe("processed");
        await expect(
            fixture.runs.find(RUN_IDS[0], caller("caller-a")),
        ).resolves.toMatchObject({
            status: "succeeded",
            output: { value: "REQUEST" },
        });
        expect(seenRunIds).toEqual([RUN_IDS[0], RUN_IDS[0]]);
    });

    it("does not retry permanent errors and fails after the declared limit", async () => {
        const permanent = defineProcessRegistration({
            id: "permanent-processing",
            version: "v1",
            inputSchema: z.strictObject({ value: z.string() }),
            outputSchema: z.strictObject({ value: z.string() }),
            retryPolicy: {
                maximumAttempts: 3,
                retryableErrorCodes: ["DEPENDENCY_FAILURE"],
                backoff: { initialDelayMs: 100, maximumDelayMs: 400 },
            },
            execute: async () =>
                failProcess("AGENT_FAILURE", "The agent rejected the request"),
        });
        const exhausted = defineProcessRegistration({
            id: "exhausted-processing",
            version: "v1",
            inputSchema: z.strictObject({ value: z.string() }),
            outputSchema: z.strictObject({ value: z.string() }),
            retryPolicy: {
                maximumAttempts: 2,
                retryableErrorCodes: ["DEPENDENCY_FAILURE"],
                backoff: { initialDelayMs: 100, maximumDelayMs: 400 },
            },
            execute: async () =>
                failProcess(
                    "DEPENDENCY_FAILURE",
                    "A required business service is unavailable",
                ),
        });
        const store = createInMemoryProcessRunStore({ maxRuns: 10 });
        const registry = createProcessRegistry([permanent, exhausted]);
        const worker = createProcessWorker({
            registry,
            store,
            attemptRunner: createProcessAttemptRunner(),
            clock: sequenceClock([
                "2026-08-09T10:00:01.000Z",
                "2026-08-09T10:00:02.000Z",
                "2026-08-09T10:00:03.000Z",
                "2026-08-09T10:00:04.000Z",
                "2026-08-09T10:00:05.000Z",
                "2026-08-09T10:00:06.000Z",
            ]),
            createClaimToken: () => "claim-token",
        });
        await store.accept(acceptedRunFor(permanent, RUN_IDS[0], "permanent"));
        await store.accept(acceptedRunFor(exhausted, RUN_IDS[1], "exhausted"));

        await expect(
            worker.process({ schemaVersion: 1, runId: RUN_IDS[0] }),
        ).resolves.toBe("processed");
        await expect(
            store.findOwned(RUN_IDS[0], "caller-a"),
        ).resolves.toMatchObject({
            status: "failed",
            attemptCount: 1,
            error: { code: "AGENT_FAILURE" },
        });

        await expect(
            worker.process({ schemaVersion: 1, runId: RUN_IDS[1] }),
        ).resolves.toEqual({ outcome: "retry-scheduled", delayMs: 100 });
        await expect(
            worker.process({ schemaVersion: 1, runId: RUN_IDS[1] }),
        ).resolves.toBe("processed");
        await expect(
            store.findOwned(RUN_IDS[1], "caller-a"),
        ).resolves.toMatchObject({
            status: "failed",
            attemptCount: 2,
            error: { code: "DEPENDENCY_FAILURE" },
        });
    });

    it("logs Process Worker outcomes by runId without accepted input or output", async () => {
        const logs: unknown[] = [];
        const fixture = createFixture([registration("v1")], {
            logSink: (record) => logs.push(record),
        });
        await fixture.runs.submit(
            {
                process: "test-processing",
                version: "v1",
                input: { value: "must-not-appear-in-worker-log" },
            },
            { callerId: "caller-a", idempotencyKey: "worker-log" },
        );

        await expect(fixture.drain.drainOne()).resolves.toBe("processed");
        expect(logs).toContainEqual(
            expect.objectContaining({
                event: "process_run_work_finished",
                runId: RUN_IDS[0],
                attemptNumber: 1,
                outcome: "processed",
            }),
        );
        expect(JSON.stringify(logs)).not.toContain(
            "must-not-appear-in-worker-log",
        );
        expect(JSON.stringify(logs)).not.toContain(
            "MUST-NOT-APPEAR-IN-WORKER-LOG",
        );
        expect(JSON.stringify(logs)).not.toContain("worker-log");
    });

    it("rejects invalid requests before allocating a run or queue job", async () => {
        const createRunId = vi.fn(() => RUN_IDS[0]);
        const fixture = createFixture([registration("v1")], { createRunId });

        await expect(
            fixture.runs.submit(
                { process: "test-processing", version: "v1", input: {} },
                {
                    callerId: "caller-a",
                    idempotencyKey: "invalid-business-input",
                },
            ),
        ).resolves.toMatchObject({
            accepted: false,
            error: { code: "INVALID_INPUT" },
        });
        await expect(
            fixture.runs.submit(
                {
                    process: "missing",
                    version: "v1",
                    input: { value: "request" },
                },
                { callerId: "caller-a", idempotencyKey: "unknown-process" },
            ),
        ).resolves.toMatchObject({
            accepted: false,
            error: { code: "PROCESS_NOT_FOUND" },
        });
        await expect(
            fixture.runs.submit(
                {
                    process: "test-processing",
                    version: "v1",
                    input: { value: "request" },
                    attempts: 100,
                },
                { callerId: "caller-a", idempotencyKey: "invalid-envelope" },
            ),
        ).resolves.toMatchObject({
            accepted: false,
            error: { code: "INVALID_INPUT" },
        });

        expect(createRunId).not.toHaveBeenCalled();
        await expect(fixture.drain.drainOne()).resolves.toBe("empty");
    });

    it.each([
        {
            scope: "caller" as const,
            code: "CALLER_BACKLOG_LIMIT_REACHED",
            message: "Caller Process Run backlog limit reached",
        },
        {
            scope: "global" as const,
            code: "ASYNC_SERVICE_CAPACITY_REACHED",
            message: "Async Process Run capacity is temporarily unavailable",
        },
    ])(
        "translates $scope Store admission at the Async Process Runs seam",
        async ({ scope, code, message }) => {
            const baseStore = createInMemoryProcessRunStore({ maxRuns: 10 });
            const runs = createAsyncProcessRuns({
                registry: createProcessRegistry([registration("v1")]),
                store: {
                    ...baseStore,
                    accept: async () => {
                        throw new ProcessRunBacklogLimitError(scope, 17);
                    },
                },
                clock: () => "2026-08-09T10:00:00.000Z",
                createRunId: () => RUN_IDS[0],
            });

            await expect(
                runs.submit(request("v1", "request"), {
                    callerId: "caller-a",
                    idempotencyKey: "capacity-test",
                }),
            ).resolves.toEqual({
                accepted: false,
                error: { code, message, retryAfterSeconds: 17 },
            });
        },
    );

    it("replays caller-scoped idempotency and rejects conflicting reuse", async () => {
        const fixture = createFixture([registration("v1")]);
        const firstRequest = {
            process: "test-processing",
            version: "v1",
            input: { first: "ignored", value: " request " },
        };
        const acceptedRequest = request("v1", "request");

        const first = await fixture.runs.submit(firstRequest, {
            callerId: "caller-a",
            idempotencyKey: "shared-key",
        });
        const replay = await fixture.runs.submit(acceptedRequest, {
            callerId: "caller-a",
            idempotencyKey: "shared-key",
        });
        expect(replay).toEqual(first);
        await expect(
            fixture.runs.submit(request("v1", "different"), {
                callerId: "caller-a",
                idempotencyKey: "shared-key",
            }),
        ).resolves.toMatchObject({
            accepted: false,
            error: { code: "IDEMPOTENCY_CONFLICT" },
        });

        const otherCaller = await fixture.runs.submit(acceptedRequest, {
            callerId: "caller-b",
            idempotencyKey: "shared-key",
        });
        expect(otherCaller).toMatchObject({
            accepted: true,
            runId: RUN_IDS[3],
        });
        expect(
            await fixture.runs.find(RUN_IDS[0], caller("caller-b")),
        ).toBeUndefined();
        expect(
            await fixture.runs.find(RUN_IDS[3], caller("caller-a")),
        ).toBeUndefined();

        await expect(fixture.drain.drainOne()).resolves.toBe("processed");
        await expect(fixture.drain.drainOne()).resolves.toBe("processed");
        await expect(fixture.drain.drainOne()).resolves.toBe("empty");

        const terminalReplay = await fixture.runs.submit(acceptedRequest, {
            callerId: "caller-a",
            idempotencyKey: "shared-key",
        });
        expect(terminalReplay).toEqual(first);
        await expect(fixture.drain.drainOne()).resolves.toBe("empty");
    });

    it("uses one queue for exact registrations and ignores duplicate terminal jobs", async () => {
        const fixture = createFixture([
            registration("v1", async (value) => ({ value: `v1:${value}` })),
            registration("v2", async (value) => ({ value: `v2:${value}` })),
        ]);
        const first = await fixture.runs.submit(request("v1", "one"), {
            callerId: "caller-a",
            idempotencyKey: "one",
        });
        const second = await fixture.runs.submit(request("v2", "two"), {
            callerId: "caller-a",
            idempotencyKey: "two",
        });
        if (!first.accepted || !second.accepted) {
            throw new Error("Expected accepted Process Runs");
        }

        await expect(fixture.drain.drainOne()).resolves.toBe("processed");
        await expect(fixture.drain.drainOne()).resolves.toBe("processed");
        expect(
            await fixture.runs.find(first.runId, caller("caller-a")),
        ).toMatchObject({
            status: "succeeded",
            output: { value: "v1:one" },
        });
        expect(
            await fixture.runs.find(second.runId, caller("caller-a")),
        ).toMatchObject({
            status: "succeeded",
            output: { value: "v2:two" },
        });

        await fixture.queue.enqueue({ schemaVersion: 1, runId: first.runId });
        await expect(fixture.drain.drainOne()).resolves.toBe("ignored");
        expect(
            await fixture.runs.find(first.runId, caller("caller-a")),
        ).toMatchObject({
            status: "succeeded",
            output: { value: "v1:one" },
        });
    });

    it("never exposes owner, accepted input, idempotency, or attempt state", async () => {
        const fixture = createFixture([registration("v1")]);
        const submission = await fixture.runs.submit(request("v1", "request"), {
            callerId: "caller-a",
            idempotencyKey: "private-key",
        });
        if (!submission.accepted)
            throw new Error("Expected accepted Process Run");

        const queued = await fixture.runs.find(
            submission.runId,
            caller("caller-a"),
        );
        expect(Object.keys(queued ?? {}).sort()).toEqual(
            ["createdAt", "process", "runId", "status", "version"].sort(),
        );
        await fixture.drain.drainOne();
        const succeeded = await fixture.runs.find(
            submission.runId,
            caller("caller-a"),
        );
        expect(Object.keys(succeeded ?? {}).sort()).toEqual(
            [
                "createdAt",
                "finishedAt",
                "output",
                "process",
                "runId",
                "startedAt",
                "status",
                "version",
            ].sort(),
        );
    });

    it("releases an active claim on cancellation and safely executes a later attempt", async () => {
        let attemptNumber = 0;
        let markStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const process = defineProcessRegistration({
            id: "test-recovery",
            version: "v1",
            inputSchema: z.strictObject({ value: z.string() }),
            outputSchema: z.strictObject({ value: z.string() }),
            execute: async (input, context) => {
                attemptNumber += 1;
                if (attemptNumber === 1) {
                    markStarted?.();
                    await new Promise<void>((resolve) =>
                        context.signal.addEventListener(
                            "abort",
                            () => resolve(),
                            {
                                once: true,
                            },
                        ),
                    );
                    return { value: "late-result" };
                }
                return { value: `recovered:${input.value}` };
            },
        });
        const acceptance = process.accept({ value: "request" });
        if (!acceptance.accepted) throw new Error("Expected accepted input");
        const store = createInMemoryProcessRunStore({ claimLeaseMs: 60_000 });
        await store.accept({
            runId: RUN_IDS[0],
            ownerId: "caller-a",
            idempotencyKey: "shutdown",
            requestFingerprint: "a".repeat(64),
            process: process.identity.id,
            version: process.identity.version,
            acceptedInput: acceptance.acceptedInput,
            createdAt: "2026-08-09T10:00:00.000Z",
        });
        const times = [
            "2026-08-09T10:00:01.000Z",
            "2026-08-09T10:00:03.000Z",
            "2026-08-09T10:00:04.000Z",
            "2026-08-09T10:00:05.000Z",
        ];
        const tokens = ["claim-first", "claim-second"];
        const worker = createProcessWorker({
            registry: createProcessRegistry([process]),
            store,
            attemptRunner: createProcessAttemptRunner(),
            clock: () => times.shift() ?? "unexpected",
            createClaimToken: () => tokens.shift() ?? "unexpected",
        });
        const controller = new AbortController();
        const firstAttempt = worker.process(
            { schemaVersion: 1, runId: RUN_IDS[0] },
            { signal: controller.signal },
        );
        await started;

        await expect(
            worker.releaseActive({ releasedAt: "2026-08-09T10:00:02.000Z" }),
        ).resolves.toBe(1);
        controller.abort();
        await expect(firstAttempt).resolves.toBe("ignored");
        await expect(
            store.findOwned(RUN_IDS[0], "caller-a"),
        ).resolves.toMatchObject({
            status: "queued",
            attemptCount: 1,
            revision: 2,
        });

        await expect(
            worker.process({ schemaVersion: 1, runId: RUN_IDS[0] }),
        ).resolves.toBe("processed");
        await expect(
            store.findOwned(RUN_IDS[0], "caller-a"),
        ).resolves.toMatchObject({
            status: "succeeded",
            output: { value: "recovered:request" },
            attemptCount: 2,
            revision: 4,
        });
    });
});

function createFixture(
    registrations: readonly ProcessRegistration[],
    options: {
        createRunId?: () => string;
        logSink?: (record: unknown) => void;
    } = {},
) {
    const store = createInMemoryProcessRunStore({ maxRuns: 20 });
    const queue = createInMemoryProcessWorkQueue({ maxJobs: 20 });
    const registry = createProcessRegistry(registrations);
    const runIds = [...RUN_IDS];
    const times = [
        "2026-08-09T10:00:00.000Z",
        "2026-08-09T10:00:01.000Z",
        "2026-08-09T10:00:02.000Z",
        "2026-08-09T10:00:03.000Z",
        "2026-08-09T10:00:04.000Z",
        "2026-08-09T10:00:05.000Z",
        "2026-08-09T10:00:06.000Z",
        "2026-08-09T10:00:07.000Z",
        "2026-08-09T10:00:08.000Z",
    ];
    const clock = () => {
        const time = times.shift();
        if (!time) throw new Error("Fixture clock exhausted");
        return time;
    };
    const runs = createAsyncProcessRuns({
        registry,
        store,
        queue,
        clock,
        createRunId:
            options.createRunId ??
            (() => {
                const id = runIds.shift();
                if (!id) throw new Error("Fixture run IDs exhausted");
                return id;
            }),
    });
    const worker = createProcessWorker({
        registry,
        store,
        attemptRunner: createProcessAttemptRunner(),
        clock,
        createClaimToken: () => "claim-token",
        logSink: options.logSink,
    });
    return {
        runs,
        queue,
        worker,
        drain: createProcessWorkerDrain({ source: queue, worker }),
    };
}

function acceptedRunFor(
    registration: ProcessRegistration,
    runId: string,
    idempotencyKey: string,
) {
    const acceptance = registration.accept({ value: "request" });
    if (!acceptance.accepted) throw new Error("Expected accepted input");
    return {
        runId,
        ownerId: "caller-a",
        idempotencyKey,
        requestFingerprint: idempotencyKey.padEnd(64, "0").slice(0, 64),
        process: registration.identity.id,
        version: registration.identity.version,
        acceptedInput: acceptance.acceptedInput,
        createdAt: "2026-08-09T10:00:00.000Z",
    };
}

function sequenceClock(values: readonly string[]): () => string {
    const remaining = [...values];
    return () => {
        const value = remaining.shift();
        if (!value) throw new Error("Fixture clock exhausted");
        return value;
    };
}

function registration(
    version: string,
    execute: (value: string) => Promise<{ value: string }> = async (value) => ({
        value,
    }),
): ProcessRegistration {
    return defineProcessRegistration({
        id: "test-processing",
        version,
        inputSchema: z
            .object({ value: z.string() })
            .transform((input) => ({ value: input.value.trim() })),
        outputSchema: z.strictObject({ value: z.string() }),
        execute: async (input) => execute(input.value),
    });
}

function request(version: string, value: string) {
    return { process: "test-processing", version, input: { value } };
}

function caller(callerId: string) {
    return { callerId };
}

const RUN_IDS = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004",
    "00000000-0000-4000-8000-000000000005",
] as const;
