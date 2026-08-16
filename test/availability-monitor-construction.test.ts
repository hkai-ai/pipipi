import { describe, expect, it, vi } from "vitest";
import { constructAvailabilityMonitor } from "../src/app/availability-monitor.js";

const REVISION = "b".repeat(40);

describe("Availability Monitor construction", () => {
    it("checks the gateway, internal roles and Redis through one Interface", async () => {
        const post = vi.fn(async () => ({ status: 204, retryAfter: null }));
        const get = vi.fn(async (request: { url: string }) => ({
            status: 200,
            body: JSON.stringify({
                status:
                    new URL(request.url).pathname === "/healthz"
                        ? "ok"
                        : "ready",
            }),
        }));
        const request = vi.fn(async (input: string) => {
            const url = new URL(input);
            const roleByPort: Readonly<Record<string, string>> = {
                "4310": "process-dispatcher",
                "4320": "process-worker",
                "4350": "webhook-worker",
                "4340": "retention-cleaner",
            };
            return Response.json({
                status:
                    url.pathname === "/healthz" || url.port === "4400"
                        ? "ok"
                        : "ready",
                ...(roleByPort[url.port] ? { role: roleByPort[url.port] } : {}),
            });
        });
        const monitor = constructAvailabilityMonitor(
            {
                PIPIPI_REVISION: REVISION,
                AVAILABILITY_PUBLIC_BASE_URL: "https://pi.example.invalid",
                AVAILABILITY_WEBHOOK_URL:
                    "https://hooks.example.invalid/robot/secret-token",
                AVAILABILITY_ASYNC_ROLES_ENABLED: "true",
                REDIS_URL:
                    "rediss://default:redis-secret@redis.internal:6379/0",
            },
            {
                request,
                publicHttpClient: { get },
                redisClient: {
                    connect: async () => undefined,
                    ping: async () => "PONG",
                    info: async (section) =>
                        section === "memory"
                            ? "maxmemory_policy:allkeys-lru\r\n"
                            : "",
                    disconnect: () => undefined,
                },
                webhookHttpClient: { post },
                clock: () => "2026-08-15T15:00:00.000Z",
            },
        );

        const result = await monitor.run();

        expect(result.report.status).toBe("degraded");
        expect(result.report.checks.map((check) => check.name)).toEqual([
            "gateway-health",
            "gateway-readiness",
            "business-api-readiness",
            "process-dispatcher-readiness",
            "process-worker-readiness",
            "webhook-worker-readiness",
            "retention-cleaner-readiness",
            "redis",
        ]);
        expect(result.notification).toBe("succeeded");
        expect(post).toHaveBeenCalledOnce();
        expect(get).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenCalledWith(
            "http://127.0.0.1:4400/readyz",
            expect.objectContaining({ method: "GET" }),
        );
        expect(JSON.stringify(result)).not.toContain("redis-secret");
        expect(JSON.stringify(result)).not.toContain("secret-token");
    });

    it("rejects missing production inputs before creating adapters", () => {
        expect(() => constructAvailabilityMonitor({})).toThrow(
            "Deployment environment for availability-monitor is missing required variables: PIPIPI_REVISION, AVAILABILITY_PUBLIC_BASE_URL, AVAILABILITY_WEBHOOK_URL",
        );
    });

    it("rejects a public base URL that is not an origin", () => {
        expect(() =>
            constructAvailabilityMonitor({
                PIPIPI_REVISION: REVISION,
                AVAILABILITY_PUBLIC_BASE_URL:
                    "https://pi.example.invalid/nested",
                AVAILABILITY_WEBHOOK_URL:
                    "https://hooks.example.invalid/robot/secret-token",
            }),
        ).toThrow("AVAILABILITY_PUBLIC_BASE_URL must use public HTTPS");
    });

    it("notifies when Redis has not been configured yet", async () => {
        const post = vi.fn(async () => ({ status: 204, retryAfter: null }));
        const monitor = constructAvailabilityMonitor(
            {
                PIPIPI_REVISION: REVISION,
                AVAILABILITY_PUBLIC_BASE_URL: "https://pi.example.invalid",
                AVAILABILITY_WEBHOOK_URL:
                    "https://hooks.example.invalid/robot/secret-token",
            },
            {
                request: async (input) => {
                    const url = new URL(input);
                    return Response.json({
                        status:
                            url.pathname === "/healthz" || url.port === "4400"
                                ? "ok"
                                : "ready",
                    });
                },
                publicHttpClient: {
                    get: async (request) => ({
                        status: 200,
                        body: JSON.stringify({
                            status:
                                new URL(request.url).pathname === "/healthz"
                                    ? "ok"
                                    : "ready",
                        }),
                    }),
                },
                webhookHttpClient: { post },
                clock: () => "2026-08-15T15:00:00.000Z",
            },
        );

        const result = await monitor.run();

        expect(result.report.checks.at(-1)).toEqual({
            name: "redis",
            kind: "redis",
            status: "unavailable",
            latencyMs: 0,
            attributes: { configurationPresent: false },
            errorCode: "REDIS_CONFIGURATION_MISSING",
        });
        expect(result.notification).toBe("succeeded");
    });
});
