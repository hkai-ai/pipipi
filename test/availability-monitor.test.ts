import { describe, expect, it, vi } from "vitest";
import { createAvailabilityMonitor } from "../src/availability/monitor.js";

const REVISION = "a".repeat(40);

describe("Availability Monitor", () => {
    it("aggregates probes and sends one sanitized unavailable report", async () => {
        const notify = vi.fn(async () => "succeeded" as const);
        const monitor = createAvailabilityMonitor({
            revision: REVISION,
            clock: () => "2026-08-15T15:00:00.000Z",
            probes: [
                {
                    name: "gateway-readiness",
                    kind: "http",
                    inspect: async () => ({
                        status: "available" as const,
                        latencyMs: 12,
                        attributes: { httpStatus: 200 },
                    }),
                },
                {
                    name: "redis",
                    kind: "redis",
                    inspect: async () => {
                        throw new Error(
                            "rediss://default:secret@redis.internal:6379/0",
                        );
                    },
                },
            ],
            notifier: { notify },
        });

        const result = await monitor.run();

        expect(result).toEqual({
            report: {
                schemaVersion: 1,
                event: "service_availability_observed",
                revision: REVISION,
                measuredAt: "2026-08-15T15:00:00.000Z",
                status: "unavailable",
                checks: [
                    {
                        name: "gateway-readiness",
                        kind: "http",
                        status: "available",
                        latencyMs: 12,
                        attributes: { httpStatus: 200 },
                    },
                    {
                        name: "redis",
                        kind: "redis",
                        status: "unavailable",
                        latencyMs: 0,
                        attributes: {},
                        errorCode: "PROBE_FAILED",
                    },
                ],
            },
            notification: "succeeded",
        });
        expect(notify).toHaveBeenCalledOnce();
        expect(JSON.stringify(notify.mock.calls)).not.toContain("secret");
        expect(JSON.stringify(result)).not.toContain("redis.internal");
    });

    it("does not notify when every check is available", async () => {
        const notify = vi.fn(async () => "succeeded" as const);
        const monitor = createAvailabilityMonitor({
            revision: REVISION,
            probes: [
                {
                    name: "gateway-health",
                    kind: "http",
                    inspect: async () => ({
                        status: "available" as const,
                        latencyMs: 1,
                        attributes: { httpStatus: 200 },
                    }),
                },
            ],
            notifier: { notify },
        });

        await expect(monitor.run()).resolves.toMatchObject({
            report: { status: "available" },
            notification: "skipped",
        });
        expect(notify).not.toHaveBeenCalled();
    });

    it("rejects duplicate probe names before any side effect", () => {
        const probe = {
            name: "redis",
            kind: "redis" as const,
            inspect: async () => ({
                status: "available" as const,
                latencyMs: 1,
                attributes: {},
            }),
        };

        expect(() =>
            createAvailabilityMonitor({
                revision: REVISION,
                probes: [probe, probe],
            }),
        ).toThrow("Availability probe names must be unique");
    });

    it("drops a probe result that hides a Secret under an unapproved attribute", async () => {
        const monitor = createAvailabilityMonitor({
            revision: REVISION,
            probes: [
                {
                    name: "redis",
                    kind: "redis",
                    inspect: async () => ({
                        status: "available" as const,
                        latencyMs: 1,
                        attributes: { detail: "rediss://secret@internal" },
                    }),
                },
            ],
        });

        const result = await monitor.run();

        expect(result.report.checks).toEqual([
            {
                name: "redis",
                kind: "redis",
                status: "unavailable",
                latencyMs: 0,
                attributes: {},
                errorCode: "PROBE_FAILED",
            },
        ]);
        expect(JSON.stringify(result)).not.toContain("secret");
    });
});
