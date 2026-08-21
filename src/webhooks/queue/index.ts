/** 定义 Webhook Work Queue/Source 接口，并提供内存实现用于测试 */
import {
    parseWebhookDeliveryJob,
    type WebhookDeliveryJob,
} from "../delivery/job.js";

export type WebhookWorkEnqueueResult = "enqueued" | "duplicate";

export type WebhookWorkQueue = Readonly<{
    enqueue: (job: WebhookDeliveryJob) => Promise<WebhookWorkEnqueueResult>;
    close: () => Promise<void>;
}>;

export type WebhookWorkSource = Readonly<{
    take: () => Promise<WebhookDeliveryJob | undefined>;
}>;

export type InMemoryWebhookWorkQueue = WebhookWorkQueue & WebhookWorkSource;

export function createInMemoryWebhookWorkQueue(
    options: { maxJobs?: number } = {},
): InMemoryWebhookWorkQueue {
    const maxJobs = positiveInteger(
        options.maxJobs ?? 100,
        "Webhook Work Queue capacity",
    );
    const jobs: WebhookDeliveryJob[] = [];
    const pendingDeliveryIds = new Set<string>();
    let closed = false;

    return Object.freeze({
        enqueue: async (rawJob) => {
            if (closed) throw new Error("Webhook Work Queue is closed");
            const job = parseWebhookDeliveryJob(rawJob);
            if (!job) throw new Error("Webhook Delivery Job is invalid");
            if (pendingDeliveryIds.has(job.deliveryId)) return "duplicate";
            if (jobs.length >= maxJobs) {
                throw new Error("Webhook Work Queue is at capacity");
            }
            jobs.push(structuredClone(job));
            pendingDeliveryIds.add(job.deliveryId);
            return "enqueued";
        },
        take: async () => {
            const job = jobs.shift();
            if (!job) return undefined;
            pendingDeliveryIds.delete(job.deliveryId);
            return structuredClone(job);
        },
        close: async () => {
            closed = true;
        },
    });
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}
