import { describe, expect, it } from "vitest";
import { createAsyncInternalSmoke } from "../src/app/async-internal-smoke.js";

const REVISION = "c".repeat(40);
const SUCCESS_RUN = "00000000-0000-4000-8000-000000000201";
const FAILURE_RUN = "00000000-0000-4000-8000-000000000202";

describe("Async internal gateway smoke", () => {
    it("verifies success, stable failure, gateway identity replacement, and owner isolation without leaking content", async () => {
        const gateway = fakeGateway();
        let sequence = 0;
        const smoke = createAsyncInternalSmoke({
            baseUrl: "https://gateway.internal.example",
            revision: REVISION,
            callerAAuthorization: "Bearer caller-a-secret",
            callerBAuthorization: "Bearer caller-b-secret",
            successRequest: {
                process: "content-processing",
                version: "v1",
                input: { content: "sensitive-success-input" },
            },
            failureRequest: {
                process: "content-processing",
                version: "v1",
                input: { content: "sensitive-failure-input" },
            },
            expectedFailureCode: "DEPENDENCY_FAILURE",
            fetch: gateway.fetch,
            clock: () => "2026-08-14T10:00:00.000Z",
            createId: () => `generated-${sequence++}`,
            wait: async () => {},
        });

        const evidence = await smoke.baseline();

        expect(evidence).toMatchObject({
            revision: REVISION,
            healthReady: true,
            ownerIsolationVerified: true,
            synchronousExecutionVerified: true,
            success: { runId: SUCCESS_RUN, status: "succeeded" },
            failure: {
                runId: FAILURE_RUN,
                status: "failed",
                errorCode: "DEPENDENCY_FAILURE",
            },
        });
        expect(gateway.spoofedHeadersSeen).toBeGreaterThan(0);
        expect(JSON.stringify(evidence)).not.toMatch(
            /sensitive-|caller-[ab]-secret|idempotency/i,
        );

        gateway.closeIntake();
        const rollback = await smoke.rollback(evidence);
        expect(rollback).toMatchObject({
            revision: REVISION,
            intakeClosed: true,
            acceptedRunsQueryable: true,
            synchronousExecutionVerified: true,
            runIds: [SUCCESS_RUN, FAILURE_RUN],
        });
        expect(JSON.stringify(rollback)).not.toMatch(
            /sensitive-|caller-[ab]-secret|idempotency/i,
        );
    });

    it("requires HTTPS and distinct caller credentials", () => {
        const common = {
            revision: REVISION,
            callerAAuthorization: "same",
            callerBAuthorization: "same",
            successRequest: {},
            failureRequest: {},
            expectedFailureCode: "DEPENDENCY_FAILURE",
        };
        expect(() =>
            createAsyncInternalSmoke({
                ...common,
                baseUrl: "http://gateway.internal.example",
            }),
        ).toThrow("HTTPS gateway URL");
        expect(() =>
            createAsyncInternalSmoke({
                ...common,
                baseUrl: "https://gateway.internal.example",
            }),
        ).toThrow("distinct credentials");
    });
});

function fakeGateway(): {
    fetch: typeof fetch;
    closeIntake: () => void;
    readonly spoofedHeadersSeen: number;
} {
    let intakeOpen = true;
    let spoofedHeadersSeen = 0;
    const handler = async (
        input: string | URL | Request,
        init?: RequestInit,
    ): Promise<Response> => {
        const url = new URL(
            input instanceof Request ? input.url : input.toString(),
        );
        const headers = new Headers(init?.headers);
        const authorization = headers.get("authorization");
        if (
            headers.get("x-pipipi-caller-id") ===
                "forged-by-smoke-must-be-removed" &&
            headers.get("x-pipipi-gateway-token") ===
                "forged-by-smoke-must-be-removed"
        ) {
            spoofedHeadersSeen += 1;
        }
        if (url.pathname === "/healthz" || url.pathname === "/readyz") {
            return json(200, { status: "ready" });
        }
        if (url.pathname === "/execute") {
            return json(200, {
                runId: "sync-run",
                process: "content-processing",
                version: "v1",
                status: "succeeded",
                output: { content: "sensitive-output" },
            });
        }
        if (url.pathname === "/process-runs" && init?.method === "POST") {
            if (!intakeOpen) {
                return json(503, {
                    status: "failed",
                    error: {
                        code: "ASYNC_INTAKE_CLOSED",
                        message:
                            "New async submissions are temporarily unavailable",
                    },
                });
            }
            const body = JSON.parse(String(init.body)) as {
                input: { content: string };
            };
            return json(202, {
                runId: body.input.content.includes("failure")
                    ? FAILURE_RUN
                    : SUCCESS_RUN,
                status: "queued",
            });
        }
        if (url.pathname.startsWith("/process-runs/")) {
            const runId = url.pathname.slice("/process-runs/".length);
            if (authorization === "Bearer caller-b-secret") {
                return json(404, {
                    status: "failed",
                    error: {
                        code: "PROCESS_RUN_NOT_FOUND",
                        message: "Process Run not found",
                    },
                });
            }
            if (runId === SUCCESS_RUN) return json(200, terminal("succeeded"));
            if (runId === FAILURE_RUN) return json(200, terminal("failed"));
            return json(404, {
                status: "failed",
                error: {
                    code: "PROCESS_RUN_NOT_FOUND",
                    message: "Process Run not found",
                },
            });
        }
        return json(404, { status: "failed" });
    };
    return {
        fetch: handler as typeof fetch,
        closeIntake: () => {
            intakeOpen = false;
        },
        get spoofedHeadersSeen() {
            return spoofedHeadersSeen;
        },
    };
}

function terminal(status: "succeeded" | "failed") {
    return {
        runId: status === "succeeded" ? SUCCESS_RUN : FAILURE_RUN,
        process: "content-processing",
        version: "v1",
        status,
        createdAt: "2026-08-14T10:00:00.000Z",
        startedAt: "2026-08-14T10:00:01.000Z",
        finishedAt: "2026-08-14T10:00:02.000Z",
        ...(status === "succeeded"
            ? { output: { content: "sensitive-output" } }
            : {
                  error: {
                      code: "DEPENDENCY_FAILURE",
                      message: "A dependency failed",
                  },
              }),
    };
}

function json(status: number, body: unknown): Response {
    return Response.json(body, {
        status,
        headers: { "content-type": "application/json" },
    });
}
