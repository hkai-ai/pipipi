import { createHmac } from "node:crypto";

export function signStandardWebhook(request: {
    messageId: string;
    timestamp: string;
    payload: string;
    secret: string;
}): string {
    if (
        request.messageId.length === 0 ||
        request.messageId.includes(".") ||
        request.timestamp.length === 0 ||
        request.timestamp.includes(".")
    ) {
        throw new Error("Webhook signing metadata is invalid");
    }
    const key = parseWebhookSecret(request.secret);
    const signature = createHmac("sha256", key)
        .update(`${request.messageId}.${request.timestamp}.${request.payload}`)
        .digest("base64");
    return `v1,${signature}`;
}

export function assertStandardWebhookSecret(secret: string): void {
    parseWebhookSecret(secret);
}

function parseWebhookSecret(secret: string): Buffer {
    if (!secret.startsWith("whsec_")) {
        throw new Error("Webhook secret must use whsec_ base64 encoding");
    }
    const encoded = secret.slice("whsec_".length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        throw new Error("Webhook secret must use whsec_ base64 encoding");
    }
    const key = Buffer.from(encoded, "base64");
    if (
        key.length < 24 ||
        key.length > 64 ||
        key.toString("base64") !== encoded
    ) {
        throw new Error("Webhook secret must use whsec_ base64 encoding");
    }
    return key;
}
