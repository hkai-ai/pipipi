import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { assertStandardWebhookSecret } from "./delivery.js";

const algorithm = "aes-256-gcm";
const envelopeVersion = "v1";
const initializationVectorBytes = 12;
const authenticationTagBytes = 16;

export type WebhookSecretCipher = Readonly<{
  encrypt: (secret: string, endpointId: string) => string;
  decrypt: (envelope: string, endpointId: string) => string;
}>;

export function createWebhookSecretCipher(options: {
  key: string | Buffer;
  keyId?: string;
  randomBytes?: (size: number) => Buffer;
}): WebhookSecretCipher {
  const key = parseEncryptionKey(options.key);
  const keyId = parseKeyId(options.keyId ?? "primary");
  const createRandomBytes = options.randomBytes ?? randomBytes;

  return Object.freeze({
    encrypt: (secret, endpointId) => {
      assertStandardWebhookSecret(secret);
      const aad = additionalAuthenticatedData(endpointId);
      const iv = createRandomBytes(initializationVectorBytes);
      if (!Buffer.isBuffer(iv) || iv.length !== initializationVectorBytes) {
        throw new Error("Webhook Secret encryption IV generation failed");
      }
      const cipher = createCipheriv(algorithm, key, iv, {
        authTagLength: authenticationTagBytes,
      });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([
        cipher.update(secret, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return [
        "enc",
        envelopeVersion,
        keyId,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
    decrypt: (envelope, endpointId) => {
      try {
        const parts = envelope.split(".");
        if (
          parts.length !== 6 ||
          parts[0] !== "enc" ||
          parts[1] !== envelopeVersion ||
          parts[2] !== keyId
        ) {
          throw new Error("invalid envelope");
        }
        const iv = decodeCanonicalBase64Url(parts[3]);
        const tag = decodeCanonicalBase64Url(parts[4]);
        const ciphertext = decodeCanonicalBase64Url(parts[5]);
        if (
          iv.length !== initializationVectorBytes ||
          tag.length !== authenticationTagBytes ||
          ciphertext.length < 1 ||
          ciphertext.length > 128
        ) {
          throw new Error("invalid envelope bounds");
        }
        const decipher = createDecipheriv(algorithm, key, iv, {
          authTagLength: authenticationTagBytes,
        });
        decipher.setAAD(additionalAuthenticatedData(endpointId));
        decipher.setAuthTag(tag);
        const secret = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
        assertStandardWebhookSecret(secret);
        return secret;
      } catch {
        throw new Error("Webhook Secret could not be decrypted");
      }
    },
  });
}

function parseEncryptionKey(value: string | Buffer): Buffer {
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : decodeCanonicalBase64(value);
  if (key.length !== 32) {
    throw new Error("Webhook Secret encryption key must be 32 base64-encoded bytes");
  }
  return key;
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Webhook Secret encryption key must be 32 base64-encoded bytes");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Webhook Secret encryption key must be 32 base64-encoded bytes");
  }
  return decoded;
}

function parseKeyId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(value)) {
    throw new Error("Webhook Secret encryption key ID is invalid");
  }
  return value;
}

function additionalAuthenticatedData(endpointId: string): Buffer {
  if (!/^[0-9a-f-]{36}$/i.test(endpointId)) {
    throw new Error("Webhook Endpoint ID is invalid for Secret encryption");
  }
  return Buffer.from(`pipipi:webhook-endpoint:${endpointId}`, "utf8");
}

function decodeCanonicalBase64Url(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("invalid base64url");
  }
  return decoded;
}
