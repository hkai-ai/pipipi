import { describe, expect, it, vi } from "vitest";
import type { AvailabilityReport } from "../src/availability/monitor.js";
import { createGenericAvailabilityWebhookNotifier } from "../src/availability/webhook.js";
import type { WebhookHttpClient } from "../src/webhooks/delivery/target-policy.js";

describe("Generic Availability Webhook Adapter", () => {
    it("sends the canonical report and accepts a 2xx response", async () => {
        const requests: Parameters<WebhookHttpClient["post"]>[0][] = [];
        const post = vi.fn(
            async (request: Parameters<WebhookHttpClient["post"]>[0]) => {
                requests.push(request);
                return { status: 204, retryAfter: null };
            },
        );
        const notifier = createGenericAvailabilityWebhookNotifier({
            url: "https://hooks.example.invalid/robot/secret-token",
            httpClient: { post },
        });

        await expect(notifier.notify(report)).resolves.toBe("succeeded");
        expect(post).toHaveBeenCalledOnce();
        const request = requests[0];
        expect(request?.headers).toMatchObject({
            "content-type": "application/json",
        });
        expect(JSON.parse(request?.body ?? "null")).toEqual(report);
    });

    it("returns a stable failure without exposing the webhook URL", async () => {
        const post = vi.fn(async () => {
            throw new Error("secret-token failed");
        });
        const notifier = createGenericAvailabilityWebhookNotifier({
            url: "https://hooks.example.invalid/robot/secret-token",
            httpClient: { post },
        });

        const result = await notifier.notify(report);

        expect(result).toBe("failed");
        expect(JSON.stringify(result)).not.toContain("secret-token");
    });
});

const report: AvailabilityReport = Object.freeze({
    schemaVersion: 1,
    event: "service_availability_observed",
    revision: "a".repeat(40),
    measuredAt: "2026-08-15T15:00:00.000Z",
    status: "unavailable",
    checks: Object.freeze([]),
});
