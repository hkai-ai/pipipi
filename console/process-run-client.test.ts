import { describe, expect, it, vi } from "vitest";
import { createProcessRunClient } from "./process-run-client.js";

describe("Console Process Run Client", () => {
    it("reports accepted and observed states before returning a typed success", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse(
                    202,
                    {
                        runId: "run-1",
                        process: "content-processing",
                        version: "v1",
                        status: "queued",
                        createdAt: "2026-08-14T00:00:00.000Z",
                    },
                    {
                        location: "/process-runs/run-1",
                        "retry-after": "1",
                    },
                ),
            )
            .mockResolvedValueOnce(
                jsonResponse(200, {
                    runId: "run-1",
                    process: "content-processing",
                    version: "v1",
                    status: "running",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    startedAt: "2026-08-14T00:00:01.000Z",
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse(200, {
                    runId: "run-1",
                    process: "content-processing",
                    version: "v1",
                    status: "succeeded",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    startedAt: "2026-08-14T00:00:01.000Z",
                    finishedAt: "2026-08-14T00:00:02.000Z",
                    output: { content: "processed" },
                }),
            );
        const wait = vi.fn().mockResolvedValue(undefined);
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-1",
            wait,
        });
        const progress = vi.fn();

        const outcome = await client.execute(
            {
                process: "content-processing",
                version: "v1",
                input: { content: "input" },
            },
            { onProgress: progress },
        );

        expect(progress.mock.calls).toEqual([
            [
                {
                    phase: "accepted",
                    runId: "run-1",
                    process: "content-processing",
                    version: "v1",
                    status: "queued",
                },
            ],
            [
                {
                    phase: "observed",
                    runId: "run-1",
                    process: "content-processing",
                    version: "v1",
                    status: "running",
                },
            ],
        ]);
        expect(outcome).toEqual({
            status: "succeeded",
            runId: "run-1",
            process: "content-processing",
            version: "v1",
            output: { content: "processed" },
        });
        expect(request).toHaveBeenNthCalledWith(
            1,
            new URL("https://pi.example/process-runs"),
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    "idempotency-key": "idempotency-1",
                }),
            }),
        );
        expect(wait).toHaveBeenCalledTimes(2);
    });

    it("returns a typed public failure", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse(
                    202,
                    {
                        runId: "run-failed",
                        process: "content-processing",
                        version: "v1",
                        status: "queued",
                        createdAt: "2026-08-14T00:00:00.000Z",
                    },
                    { location: "/process-runs/run-failed" },
                ),
            )
            .mockResolvedValueOnce(
                jsonResponse(200, {
                    runId: "run-failed",
                    process: "content-processing",
                    version: "v1",
                    status: "failed",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    startedAt: "2026-08-14T00:00:01.000Z",
                    finishedAt: "2026-08-14T00:00:02.000Z",
                    error: {
                        code: "DEPENDENCY_FAILURE",
                        message: "The dependency failed",
                    },
                }),
            );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-failed",
        });

        await expect(
            client.execute({
                process: "content-processing",
                version: "v1",
                input: { content: "input" },
            }),
        ).resolves.toEqual({
            status: "failed",
            runId: "run-failed",
            process: "content-processing",
            version: "v1",
            error: {
                code: "DEPENDENCY_FAILURE",
                message: "The dependency failed",
            },
        });
    });

    it.each(["succeeded", "failed"] as const)(
        "distinguishes an expired %s result from an empty result",
        async (resultStatus) => {
            const request = vi
                .fn()
                .mockResolvedValueOnce(
                    jsonResponse(
                        202,
                        {
                            runId: "run-expired",
                            process: "content-processing",
                            version: "v1",
                            status: resultStatus,
                            createdAt: "2026-08-14T00:00:00.000Z",
                        },
                        { location: "/process-runs/run-expired" },
                    ),
                )
                .mockResolvedValueOnce(
                    jsonResponse(200, {
                        runId: "run-expired",
                        process: "content-processing",
                        version: "v1",
                        status: resultStatus,
                        createdAt: "2026-08-14T00:00:00.000Z",
                        startedAt: "2026-08-14T00:00:01.000Z",
                        finishedAt: "2026-08-14T00:00:02.000Z",
                        resultAvailability: "expired",
                        resultExpiredAt: "2026-08-14T01:00:00.000Z",
                    }),
                );
            const client = testClient(request, {
                createIdempotencyKey: () => "idempotency-expired",
            });

            await expect(
                client.execute({
                    process: "content-processing",
                    version: "v1",
                    input: { content: "input" },
                }),
            ).resolves.toEqual({
                status: "result-expired",
                resultStatus,
                runId: "run-expired",
                process: "content-processing",
                version: "v1",
                resultExpiredAt: "2026-08-14T01:00:00.000Z",
            });
        },
    );

    it("returns a typed submission rejection without polling", async () => {
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(404, {
                status: "failed",
                error: {
                    code: "PROCESS_NOT_FOUND",
                    message: "The requested process version is not registered",
                },
            }),
        );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-rejected",
        });

        await expect(
            client.execute({
                process: "missing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "rejected",
            phase: "submission",
            httpStatus: 404,
            error: {
                code: "PROCESS_NOT_FOUND",
                message: "The requested process version is not registered",
            },
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("rejects a submission failure envelope returned with HTTP 200", async () => {
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(200, {
                status: "failed",
                error: {
                    code: "PROCESS_NOT_FOUND",
                    message: "The requested process version is not registered",
                },
            }),
        );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-status",
        });

        await expect(
            client.execute({
                process: "missing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "protocol-error",
            code: "INVALID_SUBMISSION",
        });
    });

    it("rejects a success-shaped query body returned with HTTP 500", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse(
                    202,
                    {
                        runId: "run-status",
                        process: "content-processing",
                        version: "v1",
                        status: "queued",
                        createdAt: "2026-08-14T00:00:00.000Z",
                    },
                    { location: "/process-runs/run-status" },
                ),
            )
            .mockResolvedValueOnce(
                jsonResponse(500, {
                    runId: "run-status",
                    process: "content-processing",
                    version: "v1",
                    status: "succeeded",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    startedAt: "2026-08-14T00:00:01.000Z",
                    finishedAt: "2026-08-14T00:00:02.000Z",
                    output: { content: "must not be trusted" },
                }),
            );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-status",
        });

        await expect(
            client.execute({
                process: "content-processing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "protocol-error",
            code: "INVALID_RUN",
        });
    });

    it("returns a typed query rejection for a known failure envelope", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse(
                    202,
                    {
                        runId: "run-query-failure",
                        process: "content-processing",
                        version: "v1",
                        status: "queued",
                        createdAt: "2026-08-14T00:00:00.000Z",
                    },
                    { location: "/process-runs/run-query-failure" },
                ),
            )
            .mockResolvedValueOnce(
                jsonResponse(404, {
                    status: "failed",
                    error: {
                        code: "PROCESS_RUN_NOT_FOUND",
                        message: "Process Run not found",
                    },
                }),
            );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-query-failure",
        });

        await expect(
            client.execute({
                process: "content-processing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "rejected",
            phase: "query",
            httpStatus: 404,
            runId: "run-query-failure",
            process: "content-processing",
            version: "v1",
            error: {
                code: "PROCESS_RUN_NOT_FOUND",
                message: "Process Run not found",
            },
        });
    });

    it("classifies a malformed rejection as an invalid submission response", async () => {
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(404, {
                status: "failed",
                error: { code: "PROCESS_NOT_FOUND" },
            }),
        );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-malformed-rejection",
        });

        await expect(
            client.execute({
                process: "missing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "protocol-error",
            code: "INVALID_SUBMISSION",
        });
    });

    it("rejects an unknown submission error code", async () => {
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(400, {
                status: "failed",
                error: {
                    code: "FUTURE_SUBMISSION_ERROR",
                    message: "Unknown contract extension",
                },
            }),
        );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-unknown-submission",
        });

        await expect(
            client.execute({
                process: "content-processing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "protocol-error",
            code: "INVALID_SUBMISSION",
        });
    });

    it("rejects an unknown terminal Process error code", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse(
                    202,
                    {
                        runId: "run-unknown-error",
                        process: "content-processing",
                        version: "v1",
                        status: "queued",
                        createdAt: "2026-08-14T00:00:00.000Z",
                    },
                    { location: "/process-runs/run-unknown-error" },
                ),
            )
            .mockResolvedValueOnce(
                jsonResponse(200, {
                    runId: "run-unknown-error",
                    process: "content-processing",
                    version: "v1",
                    status: "failed",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    startedAt: "2026-08-14T00:00:01.000Z",
                    finishedAt: "2026-08-14T00:00:02.000Z",
                    error: {
                        code: "FUTURE_PROCESS_ERROR",
                        message: "Unknown contract extension",
                    },
                }),
            );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-unknown-error",
        });

        await expect(
            client.execute({
                process: "content-processing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "protocol-error",
            code: "INVALID_RUN",
        });
    });

    it("rejects a cross-origin result location without querying it", async () => {
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(
                202,
                {
                    runId: "run-unsafe",
                    process: "content-processing",
                    version: "v1",
                    status: "queued",
                    createdAt: "2026-08-14T00:00:00.000Z",
                },
                {
                    location:
                        "https://attacker.example/process-runs/run-unsafe",
                },
            ),
        );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-unsafe",
        });

        await expect(
            client.execute({
                process: "content-processing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "protocol-error",
            code: "UNSAFE_LOCATION",
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("rejects a malformed Process Run location without querying it", async () => {
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(
                202,
                {
                    runId: "run-location",
                    process: "content-processing",
                    version: "v1",
                    status: "queued",
                    createdAt: "2026-08-14T00:00:00.000Z",
                },
                { location: "/process-runs/%E0%A4%A" },
            ),
        );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-location",
        });

        await expect(
            client.execute({
                process: "content-processing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "protocol-error",
            code: "UNSAFE_LOCATION",
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("maps a non-JSON response to a stable protocol error", async () => {
        const request = vi.fn().mockResolvedValueOnce(
            new Response("upstream exploded", {
                status: 502,
                headers: { "content-type": "text/plain" },
            }),
        );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-json",
        });

        await expect(
            client.execute({
                process: "content-processing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "protocol-error",
            code: "INVALID_JSON",
        });
    });

    it("stops at the default 300-second deadline before another query", async () => {
        let now = 0;
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(
                202,
                {
                    runId: "run-slow",
                    process: "content-processing",
                    version: "v1",
                    status: "queued",
                    createdAt: "2026-08-14T00:00:00.000Z",
                },
                {
                    location: "/process-runs/run-slow",
                    "retry-after": "600",
                },
            ),
        );
        const wait = vi.fn(async (milliseconds: number) => {
            now += milliseconds;
        });
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-slow",
            now: () => now,
            wait,
        });

        await expect(
            client.execute({
                process: "content-processing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "timed-out",
            runId: "run-slow",
            process: "content-processing",
            version: "v1",
            timeoutMs: 300_000,
        });
        expect(wait).toHaveBeenCalledWith(300_000);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            name: "missing runId",
            body: {
                process: "content-processing",
                version: "v1",
                status: "queued",
                createdAt: "2026-08-14T00:00:00.000Z",
            },
        },
        {
            name: "unknown status",
            body: {
                runId: "run-invalid",
                process: "content-processing",
                version: "v1",
                status: "waiting",
                createdAt: "2026-08-14T00:00:00.000Z",
            },
        },
    ])("rejects a submission with $name", async ({ body }) => {
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(202, body, {
                location: "/process-runs/run-invalid",
            }),
        );
        const client = testClient(request, {
            createIdempotencyKey: () => "idempotency-invalid",
        });

        await expect(
            client.execute({
                process: "content-processing",
                version: "v1",
                input: {},
            }),
        ).resolves.toEqual({
            status: "protocol-error",
            code: "INVALID_SUBMISSION",
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            name: "mismatched runId",
            code: "RUN_MISMATCH",
            body: {
                runId: "run-other",
                process: "content-processing",
                version: "v1",
                status: "succeeded",
                createdAt: "2026-08-14T00:00:00.000Z",
                startedAt: "2026-08-14T00:00:01.000Z",
                finishedAt: "2026-08-14T00:00:02.000Z",
                output: { content: "processed" },
            },
        },
        {
            name: "unknown status",
            code: "INVALID_RUN",
            body: {
                runId: "run-observed",
                process: "content-processing",
                version: "v1",
                status: "waiting",
                createdAt: "2026-08-14T00:00:00.000Z",
            },
        },
        {
            name: "missing running timestamp",
            code: "INVALID_RUN",
            body: {
                runId: "run-observed",
                process: "content-processing",
                version: "v1",
                status: "running",
                createdAt: "2026-08-14T00:00:00.000Z",
            },
        },
    ] as const)(
        "rejects an observed Run with $name",
        async ({ body, code }) => {
            const request = vi
                .fn()
                .mockResolvedValueOnce(
                    jsonResponse(
                        202,
                        {
                            runId: "run-observed",
                            process: "content-processing",
                            version: "v1",
                            status: "queued",
                            createdAt: "2026-08-14T00:00:00.000Z",
                        },
                        { location: "/process-runs/run-observed" },
                    ),
                )
                .mockResolvedValueOnce(jsonResponse(200, body));
            const client = testClient(request, {
                createIdempotencyKey: () => "idempotency-observed",
            });

            await expect(
                client.execute({
                    process: "content-processing",
                    version: "v1",
                    input: {},
                }),
            ).resolves.toEqual({ status: "protocol-error", code });
            expect(request).toHaveBeenCalledTimes(2);
        },
    );

    it("replays a response-lost submission with the same idempotency key", async () => {
        const pendingOperations = memoryPendingOperations();
        const request = vi
            .fn()
            .mockRejectedValueOnce(new TypeError("response lost"))
            .mockResolvedValueOnce(
                jsonResponse(
                    202,
                    {
                        runId: "run-replayed",
                        process: "content-processing",
                        version: "v1",
                        status: "queued",
                        createdAt: "2026-08-14T00:00:00.000Z",
                    },
                    { location: "/process-runs/run-replayed" },
                ),
            )
            .mockResolvedValueOnce(
                jsonResponse(200, {
                    runId: "run-replayed",
                    process: "content-processing",
                    version: "v1",
                    status: "succeeded",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    startedAt: "2026-08-14T00:00:01.000Z",
                    finishedAt: "2026-08-14T00:00:02.000Z",
                    output: { content: "once" },
                }),
            );
        const client = testClient(request, { pendingOperations });
        const processRequest = contentRequest();

        await expect(client.execute(processRequest)).resolves.toEqual({
            status: "submission-pending",
            classification: "acceptance-unknown",
        });
        await expect(client.execute(processRequest)).resolves.toMatchObject({
            status: "succeeded",
            runId: "run-replayed",
        });

        expect(idempotencyKeys(request).slice(0, 2)).toEqual([
            "idempotency-test",
            "idempotency-test",
        ]);
        expect(pendingOperations.read()).toBeNull();
    });

    it("recovers an accepted Run after a browser refresh", async () => {
        const pendingOperations = memoryPendingOperations();
        let now = 0;
        const firstRequest = vi.fn().mockResolvedValueOnce(
            jsonResponse(
                202,
                {
                    runId: "run-refresh",
                    process: "content-processing",
                    version: "v1",
                    status: "queued",
                    createdAt: "2026-08-14T00:00:00.000Z",
                },
                {
                    location: "/process-runs/run-refresh",
                    "retry-after": "10",
                },
            ),
        );
        const firstClient = testClient(firstRequest, {
            now: () => now,
            pendingOperations,
            wait: async (milliseconds) => {
                now += milliseconds;
            },
        });

        await expect(
            firstClient.execute(contentRequest(), { timeoutMs: 1 }),
        ).resolves.toMatchObject({
            status: "timed-out",
            runId: "run-refresh",
        });

        const refreshedRequest = vi.fn().mockResolvedValueOnce(
            jsonResponse(200, {
                runId: "run-refresh",
                process: "content-processing",
                version: "v1",
                status: "succeeded",
                createdAt: "2026-08-14T00:00:00.000Z",
                startedAt: "2026-08-14T00:00:01.000Z",
                finishedAt: "2026-08-14T00:00:02.000Z",
                output: { content: "recovered" },
            }),
        );
        const refreshedClient = testClient(refreshedRequest, {
            pendingOperations,
        });

        expect(refreshedClient.pending()).toEqual({
            classification: "accepted",
            createdAt: "1970-01-01T00:00:00.000Z",
            runId: "run-refresh",
        });
        await expect(
            refreshedClient.execute(contentRequest()),
        ).resolves.toMatchObject({
            status: "succeeded",
            runId: "run-refresh",
        });
        expect(refreshedRequest).toHaveBeenCalledWith(
            new URL("https://pi.example/process-runs/run-refresh"),
            { headers: { accept: "application/json" } },
        );
        expect(pendingOperations.read()).toBeNull();
    });

    it.each([
        {
            status: 429,
            code: "CALLER_BACKLOG_LIMIT_REACHED",
        },
        {
            status: 503,
            code: "ASYNC_SERVICE_CAPACITY_REACHED",
        },
        {
            status: 503,
            code: "ASYNC_SERVICE_UNAVAILABLE",
        },
        {
            status: 503,
            code: "SERVICE_BUSY",
        },
    ])(
        "keeps the key for retryable $status $code admission",
        async ({ status, code }) => {
            const pendingOperations = memoryPendingOperations();
            const request = vi.fn().mockResolvedValueOnce(
                jsonResponse(
                    status,
                    {
                        status: "failed",
                        error: { code, message: "Retry later" },
                    },
                    { "retry-after": "3" },
                ),
            );
            const client = testClient(request, { pendingOperations });

            await expect(client.execute(contentRequest())).resolves.toEqual({
                status: "submission-pending",
                classification: "retryable",
                httpStatus: status,
                retryAfterMs: 3_000,
                error: { code, message: "Retry later" },
            });
            expect(client.pending()).toEqual({
                classification: "retryable",
                createdAt: "1970-01-01T00:00:00.000Z",
            });
            expect(idempotencyKeys(request)).toEqual(["idempotency-test"]);
        },
    );

    it.each([
        { status: 400, code: "INVALID_INPUT" },
        { status: 404, code: "PROCESS_NOT_FOUND" },
        { status: 409, code: "IDEMPOTENCY_CONFLICT" },
    ])(
        "clears a definitive $status $code rejection",
        async ({ status, code }) => {
            const pendingOperations = memoryPendingOperations();
            const request = vi.fn().mockResolvedValueOnce(
                jsonResponse(status, {
                    status: "failed",
                    error: { code, message: "Definitive rejection" },
                }),
            );
            const client = testClient(request, { pendingOperations });

            await expect(
                client.execute(contentRequest()),
            ).resolves.toMatchObject({
                status: "rejected",
                phase: "submission",
                error: { code },
            });
            expect(client.pending()).toBeUndefined();
            expect(pendingOperations.read()).toBeNull();
        },
    );

    it("rotates the idempotency key only for an explicit new operation", async () => {
        const pendingOperations = memoryPendingOperations();
        const keys = ["idempotency-original", "idempotency-new"];
        const request = vi
            .fn()
            .mockRejectedValueOnce(new TypeError("response lost"))
            .mockRejectedValueOnce(new TypeError("response lost again"));
        const client = testClient(request, {
            createIdempotencyKey: () => keys.shift() ?? "unexpected-key",
            pendingOperations,
        });

        await client.execute(contentRequest());
        await client.execute(contentRequest(), { intent: "new" });

        expect(idempotencyKeys(request)).toEqual([
            "idempotency-original",
            "idempotency-new",
        ]);
    });

    it("does not create a concurrent submission intent for repeated execution", async () => {
        let resolveResponse: ((response: Response) => void) | undefined;
        const request = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    resolveResponse = resolve;
                }),
        );
        const createIdempotencyKey = vi.fn(() => "idempotency-active");
        const client = testClient(request, { createIdempotencyKey });

        const first = client.execute(contentRequest());
        const repeated = client.execute(contentRequest());
        await expect(repeated).resolves.toEqual({
            status: "recovery-error",
            code: "ACTIVE_OPERATION",
        });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        resolveResponse?.(
            jsonResponse(400, {
                status: "failed",
                error: { code: "INVALID_INPUT", message: "Invalid input" },
            }),
        );
        await first;

        expect(createIdempotencyKey).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("rejects a different request while an operation is active", async () => {
        let resolveResponse: ((response: Response) => void) | undefined;
        const request = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    resolveResponse = resolve;
                }),
        );
        const client = testClient(request);

        const active = client.execute(contentRequest());
        const different = client.execute(
            { ...contentRequest(), input: { content: "different" } },
            { intent: "new" },
        );
        await expect(different).resolves.toEqual({
            status: "recovery-error",
            code: "ACTIVE_OPERATION",
        });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        resolveResponse?.(
            jsonResponse(400, {
                status: "failed",
                error: { code: "INVALID_INPUT", message: "Invalid input" },
            }),
        );
        await active;
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("does not overwrite an accepted mapping with an explicit new operation", async () => {
        const pendingOperations = memoryPendingOperations();
        let now = 0;
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(
                202,
                {
                    runId: "run-preserved",
                    process: "content-processing",
                    version: "v1",
                    status: "queued",
                    createdAt: "2026-08-14T00:00:00.000Z",
                },
                {
                    location: "/process-runs/run-preserved",
                    "retry-after": "10",
                },
            ),
        );
        const createIdempotencyKey = vi.fn(() => "idempotency-preserved");
        const client = testClient(request, {
            createIdempotencyKey,
            now: () => now,
            pendingOperations,
            wait: async (milliseconds) => {
                now += milliseconds;
            },
        });
        await client.execute(contentRequest(), { timeoutMs: 1 });

        await expect(
            client.execute(contentRequest(), { intent: "new" }),
        ).resolves.toEqual({
            status: "recovery-error",
            code: "ACCEPTED_OPERATION_ACTIVE",
        });
        expect(client.pending()).toMatchObject({
            classification: "accepted",
            runId: "run-preserved",
        });
        expect(createIdempotencyKey).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("normalizes unavailable recovery storage without issuing a POST", async () => {
        const request = vi.fn();
        const client = testClient(request, {
            pendingOperations: {
                read: () => {
                    throw new DOMException("denied", "SecurityError");
                },
                write: () => undefined,
                clear: () => undefined,
            },
        });

        expect(client.pending()).toEqual({ classification: "unavailable" });
        await expect(client.execute(contentRequest())).resolves.toEqual({
            status: "recovery-error",
            code: "STORAGE_UNAVAILABLE",
        });
        expect(request).not.toHaveBeenCalled();
    });

    it("does not issue a POST when recovery metadata cannot be persisted", async () => {
        const request = vi.fn();
        const client = testClient(request, {
            pendingOperations: {
                read: () => null,
                write: () => {
                    throw new DOMException("quota", "QuotaExceededError");
                },
                clear: () => undefined,
            },
        });

        await expect(client.execute(contentRequest())).resolves.toEqual({
            status: "recovery-error",
            code: "STORAGE_UNAVAILABLE",
        });
        expect(request).not.toHaveBeenCalled();
    });

    it("reports that a recovery mapping could not be dismissed", () => {
        const client = testClient(vi.fn(), {
            pendingOperations: {
                read: () => null,
                write: () => undefined,
                clear: () => {
                    throw new DOMException("denied", "SecurityError");
                },
            },
        });

        expect(client.dismiss()).toBe(false);
    });

    it("persists recovery metadata before POST without persisting business input", async () => {
        const pendingOperations = memoryPendingOperations();
        let stateAtPost: string | null = null;
        const request = vi.fn(async () => {
            stateAtPost = pendingOperations.read();
            throw new TypeError("response lost");
        });
        const client = testClient(request, { pendingOperations });

        await client.execute(contentRequest());

        expect(stateAtPost).not.toBeNull();
        expect(Object.keys(JSON.parse(stateAtPost ?? "{}")).sort()).toEqual([
            "classification",
            "createdAt",
            "idempotencyKey",
            "requestFingerprint",
            "schemaVersion",
        ]);
        expect(stateAtPost).not.toContain('"content":"input"');
    });

    it("does not replay an uncertain operation with different input", async () => {
        const pendingOperations = memoryPendingOperations();
        const firstClient = testClient(
            vi.fn().mockRejectedValueOnce(new TypeError("response lost")),
            { pendingOperations },
        );
        await firstClient.execute(contentRequest());

        const refreshedRequest = vi.fn();
        const refreshedClient = testClient(refreshedRequest, {
            pendingOperations,
        });
        await expect(
            refreshedClient.execute({
                ...contentRequest(),
                input: { content: "different" },
            }),
        ).resolves.toEqual({
            status: "recovery-error",
            code: "REQUEST_MISMATCH",
        });
        expect(refreshedRequest).not.toHaveBeenCalled();
    });
});

type ClientAdapters = Parameters<typeof createProcessRunClient>[0];

function testClient(
    request: ClientAdapters["request"],
    overrides: Partial<Omit<ClientAdapters, "request">> = {},
) {
    return createProcessRunClient({
        baseUrl: () => "https://pi.example/console/",
        createIdempotencyKey: () => "idempotency-test",
        fingerprint: async (value) => testFingerprint(value),
        now: () => 0,
        pendingOperations: memoryPendingOperations(),
        wait: async () => undefined,
        ...overrides,
        request,
    });
}

function testFingerprint(value: string): string {
    let hash = 0;
    for (const character of value) {
        hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

function contentRequest() {
    return {
        process: "content-processing",
        version: "v1",
        input: { content: "input" },
    };
}

function memoryPendingOperations() {
    let value: string | null = null;
    return {
        read: () => value,
        write: (next: string) => {
            value = next;
        },
        clear: () => {
            value = null;
        },
    };
}

function idempotencyKeys(request: ReturnType<typeof vi.fn>): unknown[] {
    return request.mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([, init]) => new Headers(init.headers).get("idempotency-key"));
}

function jsonResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}
