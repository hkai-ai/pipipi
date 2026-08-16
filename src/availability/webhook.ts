import {
    createPinnedWebhookHttpClient,
    createWebhookTargetPolicy,
    type WebhookHttpClient,
} from "../webhooks/delivery/target-policy.js";
import type { AvailabilityNotifier, AvailabilityReport } from "./monitor.js";

export function createGenericAvailabilityWebhookNotifier(options: {
    url: string;
    timeoutMs?: number;
    httpClient?: WebhookHttpClient;
}): AvailabilityNotifier {
    const url = parseWebhookUrl(options.url);
    const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000);
    const httpClient =
        options.httpClient ??
        createPinnedWebhookHttpClient({
            targetPolicy: createWebhookTargetPolicy(),
        });

    return Object.freeze({
        notify: async (
            report: AvailabilityReport,
        ): Promise<"succeeded" | "failed"> => {
            const body = JSON.stringify(report);
            if (Buffer.byteLength(body, "utf8") > 20_480) return "failed";
            try {
                const response = await httpClient.post({
                    url,
                    headers: {
                        "content-type": "application/json",
                        accept: "application/json",
                    },
                    body,
                    signal: AbortSignal.timeout(timeoutMs),
                });
                return response.status >= 200 && response.status <= 299
                    ? "succeeded"
                    : "failed";
            } catch {
                return "failed";
            }
        },
    });
}

function parseWebhookUrl(value: string): string {
    try {
        const url = new URL(value.trim());
        if (
            url.protocol !== "https:" ||
            !url.hostname ||
            url.username ||
            url.password
        ) {
            throw new Error();
        }
        return url.toString();
    } catch {
        throw new Error("Availability Webhook URL must use public HTTPS");
    }
}

function positiveInteger(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
        throw new Error(
            "Availability Webhook timeout must be between 1 and 60000 milliseconds",
        );
    }
    return value;
}
