import {
    createPinnedPublicHttpTransport,
    createPublicHttpTargetPolicy,
    type PublicHttpTransport,
} from "../network/public-http.js";
import type {
    AvailabilityCheck,
    AvailabilityNotifier,
    AvailabilityReport,
} from "./monitor.js";

export function createFeishuAvailabilityWebhookNotifier(options: {
    url: string;
    timeoutMs?: number;
    transport?: PublicHttpTransport;
}): AvailabilityNotifier {
    const url = parseFeishuBotUrl(options.url);
    const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000);
    const transport =
        options.transport ??
        createPinnedPublicHttpTransport({
            targetPolicy: createPublicHttpTargetPolicy(),
        });

    return Object.freeze({
        notify: async (
            report: AvailabilityReport,
        ): Promise<"succeeded" | "failed"> => {
            const body = JSON.stringify({
                msg_type: "text",
                content: { text: formatAlert(report) },
            });
            if (Buffer.byteLength(body, "utf8") > 20_480) return "failed";
            try {
                const response = await transport.request({
                    url,
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        accept: "application/json",
                    },
                    body,
                    signal: AbortSignal.timeout(timeoutMs),
                    maxResponseBytes: 20_480,
                });
                if (response.status !== 200) return "failed";
                return feishuAccepted(response.body) ? "succeeded" : "failed";
            } catch {
                return "failed";
            }
        },
    });
}

function formatAlert(report: AvailabilityReport): string {
    const failedChecks = report.checks.filter(
        (check) => check.status !== "available",
    );
    return [
        "[PiPiPi 服务可用性告警]",
        `状态: ${report.status}`,
        `时间: ${report.measuredAt}`,
        `版本: ${report.revision}`,
        "异常检查:",
        ...failedChecks.map(formatCheck),
    ].join("\n");
}

function formatCheck(check: AvailabilityCheck): string {
    const details = Object.entries(check.attributes)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(", ");
    return [
        `- ${check.name}: ${check.status}`,
        `${check.latencyMs}ms`,
        check.errorCode,
        details || undefined,
    ]
        .filter((value) => value !== undefined)
        .join(" | ");
}

function feishuAccepted(value: string): boolean {
    try {
        const body: unknown = JSON.parse(value);
        return (
            typeof body === "object" &&
            body !== null &&
            !Array.isArray(body) &&
            (body as Record<string, unknown>).code === 0
        );
    } catch {
        return false;
    }
}

function parseFeishuBotUrl(value: string): string {
    try {
        const url = new URL(value.trim());
        if (
            url.protocol !== "https:" ||
            url.hostname !== "open.feishu.cn" ||
            url.port ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{16,128}$/.test(
                url.pathname,
            )
        ) {
            throw new Error();
        }
        return url.toString();
    } catch {
        throw new Error(
            "Availability Webhook URL must be a Feishu V2 bot hook",
        );
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
