/** CRT Rendering Capability、PNG 引用契约 */
import { z } from "zod";
import type { CrtAspectRatio, CrtGrain, CrtPalette } from "./style.js";

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

/**
 * The model's edit before the deterministic CRT treatment. It is delivered so
 * callers can request another grain later without paying for a second render,
 * so it carries the provider's own raster shape rather than the CRT output
 * constraints.
 */
export const crtRawImageSchema = z.strictObject({
    url: z
        .string()
        .trim()
        .max(2_048)
        .refine(isSafeHttpUrl, "CRT raw image URL must be HTTP(S)"),
    contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.int().positive().max(8_192),
    height: z.int().positive().max(8_192),
    expiresAt: z.iso.datetime().optional(),
});

export type CrtRawImage = z.infer<typeof crtRawImageSchema>;

export const crtRenderingResultSchema = z.strictObject({
    image: crtImageSchema,
    rawImage: crtRawImageSchema,
});

export type CrtRenderingResult = z.infer<typeof crtRenderingResultSchema>;

export type CrtRenderingCapability = Readonly<{
    transform: (
        input: {
            sourceImageUrl: string;
            prompt: string;
            palette: CrtPalette;
            aspectRatio: CrtAspectRatio;
            grain: CrtGrain;
        },
        options: { signal: AbortSignal; idempotencyKey: string },
    ) => Promise<CrtRenderingResult>;
}>;

/**
 * `committed` records whether the image edit had already returned when the
 * failure happened. Everything before that point is free to retry; everything
 * after it has already been paid for. The Registration turns this one bit into
 * the public error code, so callers never have to read logs to decide whether a
 * retry spends money again.
 */
export class CrtRenderingUnavailable extends Error {
    readonly committed: boolean;

    constructor(options: ErrorOptions & { committed?: boolean } = {}) {
        super("CRT rendering is unavailable", options);
        this.name = "CrtRenderingUnavailable";
        this.committed = options.committed ?? false;
    }
}

/** Error code returned by `POST /crt-images` after the edit has been charged. */
export const crtRenderingIncompleteCode = "CRT_RENDERING_INCOMPLETE";

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

export function parseCrtRenderingResult(value: unknown): CrtRenderingResult {
    return crtRenderingResultSchema.parse(value);
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
