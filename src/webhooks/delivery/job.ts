export type WebhookDeliveryJob = Readonly<{
    schemaVersion: 1;
    deliveryId: string;
}>;

export function parseWebhookDeliveryJob(
    value: unknown,
): WebhookDeliveryJob | undefined {
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        return undefined;
    }
    const candidate = value as Record<string, unknown>;
    if (
        Object.keys(candidate).length !== 2 ||
        candidate.schemaVersion !== 1 ||
        typeof candidate.deliveryId !== "string" ||
        candidate.deliveryId.trim().length === 0 ||
        Buffer.byteLength(candidate.deliveryId, "utf8") > 256
    ) {
        return undefined;
    }
    return Object.freeze({
        schemaVersion: 1,
        deliveryId: candidate.deliveryId,
    });
}
