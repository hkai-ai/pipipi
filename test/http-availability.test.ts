import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    createHttpAvailabilityProbe,
    createPublicHttpAvailabilityProbe,
} from "../src/availability/http.js";
import { startLocalCrtBusinessApi } from "../src/business-api/crt-server.js";
import { createPublicHttpTargetPolicy } from "../src/network/public-http.js";

describe("HTTP Availability Probe", () => {
    it("accepts the expected readiness shape without exposing the target", async () => {
        const request = vi.fn(async () =>
            Response.json({ status: "ready", role: "process-worker" }),
        );
        const probe = createHttpAvailabilityProbe({
            name: "process-worker-readiness",
            url: "http://127.0.0.1:4320/readyz?token=secret",
            expectedStatus: "ready",
            expectedRole: "process-worker",
            request,
            clock: timestamps(100, 112),
        });

        const result = await probe.inspect();

        expect(result).toEqual({
            status: "available",
            latencyMs: 12,
            attributes: {
                httpStatus: 200,
                semanticStatus: "ready",
                role: "process-worker",
            },
        });
        expect(JSON.stringify(result)).not.toContain("secret");
    });

    it("fails closed on an unexpected or unavailable response", async () => {
        const request = vi.fn(async () =>
            Response.json(
                { status: "not_ready", detail: "database-secret" },
                { status: 503 },
            ),
        );
        const probe = createHttpAvailabilityProbe({
            name: "api-readiness",
            url: "https://pi.example.invalid/readyz",
            expectedStatus: "ready",
            request,
        });

        const result = await probe.inspect();

        expect(result).toMatchObject({
            status: "unavailable",
            attributes: { httpStatus: 503 },
            errorCode: "HTTP_UNAVAILABLE",
        });
        expect(JSON.stringify(result)).not.toContain("database-secret");
    });

    it("accepts the real CRT Business API readiness contract", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-availability-"));
        const api = await startLocalCrtBusinessApi({
            directory,
            imageClient: {
                edit: async () => {
                    throw new Error("not called");
                },
            },
        });

        try {
            const result = await createHttpAvailabilityProbe({
                name: "business-api-readiness",
                url: `${api.url}/readyz`,
                expectedStatus: "ok",
            }).inspect();

            expect(result).toMatchObject({
                status: "available",
                attributes: {
                    httpStatus: 200,
                    semanticStatus: "ok",
                },
            });
        } finally {
            await api.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.each([
        ["https://127.0.0.1/readyz", undefined],
        [
            "https://public.example/readyz",
            createPublicHttpTargetPolicy({
                resolveHostname: async () => [
                    { address: "169.254.169.254", family: 4 },
                ],
            }),
        ],
    ])("fails closed for a non-public target %s", async (url, targetPolicy) => {
        const result = await createPublicHttpAvailabilityProbe({
            name: "gateway-readiness",
            url,
            expectedStatus: "ready",
            targetPolicy,
        }).inspect();

        expect(result).toMatchObject({
            status: "unavailable",
            attributes: {},
            errorCode: "HTTP_UNAVAILABLE",
        });
    });
});

function timestamps(...values: number[]) {
    let index = 0;
    return () => values[index++] ?? values.at(-1) ?? 0;
}
