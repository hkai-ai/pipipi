import { describe, expect, it, vi } from "vitest";
import type { AvailabilityReport } from "../src/availability/monitor.js";
import { createFeishuAvailabilityWebhookNotifier } from "../src/availability/webhook.js";
import type { PublicHttpTransport } from "../src/network/public-http.js";

describe("Feishu Availability Webhook Adapter", () => {
    it("sends a V2 text message and requires a successful Feishu code", async () => {
        const requests: Parameters<PublicHttpTransport["request"]>[0][] = [];
        const request = vi.fn(
            async (input: Parameters<PublicHttpTransport["request"]>[0]) => {
                requests.push(input);
                return {
                    status: 200,
                    retryAfter: null,
                    body: JSON.stringify({ code: 0, msg: "success", data: {} }),
                };
            },
        );
        const notifier = createFeishuAvailabilityWebhookNotifier({
            url: "https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-4000-8000-000000000000",
            transport: { request },
        });

        await expect(notifier.notify(report)).resolves.toBe("succeeded");
        expect(request).toHaveBeenCalledOnce();
        const sent = requests[0];
        expect(sent).toMatchObject({
            method: "POST",
            maxResponseBytes: 20_480,
            headers: { "content-type": "application/json" },
        });
        const payload = JSON.parse(sent?.body ?? "null") as {
            msg_type: string;
            content: { text: string };
        };
        expect(payload.msg_type).toBe("text");
        expect(payload.content.text).toContain("PiPiPi 服务可用性告警");
        expect(payload.content.text).toContain("redis: unavailable");
        expect(payload.content.text).not.toContain("https://");
    });

    it("fails when Feishu rejects a valid HTTP response", async () => {
        const notifier = createFeishuAvailabilityWebhookNotifier({
            url: "https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-4000-8000-000000000000",
            transport: {
                request: async () => ({
                    status: 200,
                    retryAfter: null,
                    body: JSON.stringify({
                        code: 19024,
                        msg: "Key Words Not Found secret-token",
                    }),
                }),
            },
        });

        const result = await notifier.notify(report);

        expect(result).toBe("failed");
        expect(JSON.stringify(result)).not.toContain("secret-token");
    });

    it("rejects non-Feishu and query-bearing webhook URLs", () => {
        expect(() =>
            createFeishuAvailabilityWebhookNotifier({
                url: "https://hooks.example.invalid/robot/token",
            }),
        ).toThrow("Availability Webhook URL must be a Feishu V2 bot hook");
        expect(() =>
            createFeishuAvailabilityWebhookNotifier({
                url: "https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-4000-8000-000000000000?token=override",
            }),
        ).toThrow("Availability Webhook URL must be a Feishu V2 bot hook");
    });
});

const report: AvailabilityReport = Object.freeze({
    schemaVersion: 1,
    event: "service_availability_observed",
    revision: "a".repeat(40),
    measuredAt: "2026-08-15T15:00:00.000Z",
    status: "unavailable",
    checks: Object.freeze([
        Object.freeze({
            name: "redis",
            kind: "redis",
            status: "unavailable",
            latencyMs: 12,
            attributes: Object.freeze({ configurationPresent: false }),
            errorCode: "REDIS_CONFIGURATION_MISSING",
        }),
    ]),
});
