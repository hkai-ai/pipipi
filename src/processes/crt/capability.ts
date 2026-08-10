import { z } from "zod";
import type { CrtAspectRatio, CrtPalette } from "./style.js";

export const crtImageSchema = z
    .strictObject({
        url: z
            .string()
            .trim()
            .max(2_048)
            .refine(isSafeHttpUrl, "CRT image URL must be HTTP(S)"),
        contentType: z.literal("image/png"),
        width: z.int().positive().max(3_840).refine(isMultipleOf16),
        height: z.int().positive().max(3_840).refine(isMultipleOf16),
        expiresAt: z.iso.datetime().optional(),
    })
    .refine((image) => {
        const pixels = image.width * image.height;
        return pixels >= 655_360 && pixels <= 8_294_400;
    }, "CRT image dimensions must satisfy the GPT Image 2 pixel bounds");

export type CrtImage = z.infer<typeof crtImageSchema>;

export type CrtRenderingCapability = Readonly<{
    transform: (
        input: {
            sourceImageUrl: string;
            prompt: string;
            palette: CrtPalette;
            aspectRatio: CrtAspectRatio;
        },
        options: { signal: AbortSignal; idempotencyKey: string },
    ) => Promise<CrtImage>;
}>;

export class CrtRenderingUnavailable extends Error {
    constructor(options?: ErrorOptions) {
        super("CRT rendering is unavailable", options);
        this.name = "CrtRenderingUnavailable";
    }
}

export function isPublicSourceImageUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        return (
            url.protocol === "https:" &&
            url.username.length === 0 &&
            url.password.length === 0 &&
            url.port.length === 0 &&
            url.hash.length === 0 &&
            hostname.includes(".") &&
            hostname !== "localhost" &&
            !hostname.endsWith(".localhost") &&
            !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) &&
            !hostname.startsWith("[")
        );
    } catch {
        return false;
    }
}

export function parseCrtImage(value: unknown): CrtImage {
    return crtImageSchema.parse(value);
}

function isMultipleOf16(value: number): boolean {
    return value % 16 === 0;
}

function isSafeHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            url.username.length === 0 &&
            url.password.length === 0
        );
    } catch {
        return false;
    }
}
