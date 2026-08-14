import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAsync } from "./api.js";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("console async execution", () => {
    it("submits with an idempotency key and follows the result location", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("document", { baseURI: "https://pi.example/console/" });
        const request = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse(
                    202,
                    { runId: "run-1", status: "queued" },
                    { location: "/process-runs/run-1", "retry-after": "1" },
                ),
            )
            .mockResolvedValueOnce(
                jsonResponse(200, {
                    runId: "run-1",
                    process: "content-processing",
                    version: "v1",
                    status: "succeeded",
                    createdAt: "2026-08-13T00:00:00.000Z",
                    startedAt: "2026-08-13T00:00:01.000Z",
                    finishedAt: "2026-08-13T00:00:02.000Z",
                    output: { content: "processed" },
                }),
            );
        vi.stubGlobal("fetch", request);
        vi.stubGlobal("crypto", { randomUUID: () => "idempotency-1" });

        const outcome = executeAsync("content-processing", "v1", {
            content: "input",
        });
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(outcome).resolves.toMatchObject({
            httpStatus: 200,
            body: { runId: "run-1", status: "succeeded" },
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
        expect(request).toHaveBeenNthCalledWith(
            2,
            new URL("https://pi.example/process-runs/run-1"),
            { headers: { accept: "application/json" } },
        );
    });

    it("returns an async submission rejection without polling", async () => {
        vi.stubGlobal("document", { baseURI: "https://pi.example/console/" });
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(404, {
                status: "failed",
                error: { code: "PROCESS_NOT_FOUND" },
            }),
        );
        vi.stubGlobal("fetch", request);
        vi.stubGlobal("crypto", { randomUUID: () => "idempotency-1" });

        await expect(executeAsync("missing", "v1", {})).resolves.toMatchObject({
            httpStatus: 404,
            body: { error: { code: "PROCESS_NOT_FOUND" } },
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("stops polling after the default 300 seconds without cancelling the Run", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("document", { baseURI: "https://pi.example/console/" });
        vi.stubGlobal("crypto", { randomUUID: () => "idempotency-1" });
        const request = vi.fn().mockResolvedValueOnce(
            jsonResponse(
                202,
                { runId: "run-slow", status: "queued" },
                {
                    location: "/process-runs/run-slow",
                    "retry-after": "600",
                },
            ),
        );
        vi.stubGlobal("fetch", request);

        const outcome = executeAsync("content-processing", "v1", {});
        const rejection = expect(outcome).rejects.toThrow(
            "等待异步结果超过 300 秒；Run run-slow 仍会在服务端继续执行",
        );
        await vi.advanceTimersByTimeAsync(300_000);

        await rejection;
        expect(request).toHaveBeenCalledTimes(1);
    });
});

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
