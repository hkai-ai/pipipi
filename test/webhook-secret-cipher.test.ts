import { describe, expect, it } from "vitest";
import { createWebhookSecretCipher } from "../src/webhooks/store/secret-cipher.js";

const endpointId = "20000000-0000-4000-8000-000000000020";
const secret = `whsec_${Buffer.alloc(32, 20).toString("base64")}`;

describe("Webhook Secret cipher", () => {
    it("encrypts with AES-GCM randomness and binds the envelope to one Endpoint", () => {
        const cipher = createWebhookSecretCipher({ key: Buffer.alloc(32, 7) });
        const first = cipher.encrypt(secret, endpointId);
        const second = cipher.encrypt(secret, endpointId);

        expect(first).not.toBe(second);
        expect(first).not.toContain(secret);
        expect(cipher.decrypt(first, endpointId)).toBe(secret);
        expect(() =>
            cipher.decrypt(first, "20000000-0000-4000-8000-000000000021"),
        ).toThrow("Webhook Secret could not be decrypted");
    });

    it("rejects malformed keys and tampered envelopes without echoing either value", () => {
        expect(() => createWebhookSecretCipher({ key: "not-a-key" })).toThrow(
            "Webhook Secret encryption key must be 32 base64-encoded bytes",
        );
        const cipher = createWebhookSecretCipher({ key: Buffer.alloc(32, 8) });
        const envelope = cipher.encrypt(secret, endpointId);
        const tampered = `${envelope.slice(0, -1)}x`;
        expect(() => cipher.decrypt(tampered, endpointId)).toThrow(
            "Webhook Secret could not be decrypted",
        );
        try {
            cipher.decrypt(tampered, endpointId);
        } catch (error) {
            expect(String(error)).not.toContain(tampered);
            expect(String(error)).not.toContain(secret);
        }
    });
});
