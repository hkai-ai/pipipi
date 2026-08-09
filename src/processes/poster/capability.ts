import { z } from "zod";

export const posterImageSchema = z.strictObject({
    url: z
        .string()
        .trim()
        .max(2_048)
        .refine(isSafeHttpUrl, "Poster image URL must be HTTP(S)"),
    contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.int().positive().max(16_384),
    height: z.int().positive().max(16_384),
    expiresAt: z.iso.datetime().optional(),
});

export type PosterImage = z.infer<typeof posterImageSchema>;

export type PosterRenderingCapability = Readonly<{
    render: (
        input: { prompt: string; aspectRatio: "3:5" },
        options: { signal: AbortSignal; idempotencyKey: string },
    ) => Promise<PosterImage>;
}>;

export class PosterRenderingUnavailable extends Error {
    constructor(options?: ErrorOptions) {
        super("Poster rendering is unavailable", options);
        this.name = "PosterRenderingUnavailable";
    }
}

export function parsePosterImage(value: unknown): PosterImage {
    return posterImageSchema.parse(value);
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
