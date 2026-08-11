import { z } from "zod";

export const newsImageSchema = z
    .strictObject({
        url: z
            .string()
            .trim()
            .max(2_048)
            .refine(isSafeHttpUrl, "News image URL must be HTTP(S)"),
        contentType: z.literal("image/png"),
        width: z.int().positive().max(3_840),
        height: z.int().positive().max(3_840),
        expiresAt: z.iso.datetime().optional(),
    })
    .refine(
        (image) => Math.abs(image.width / image.height - 4 / 3) < 0.015,
        "News image must keep the 4:3 aspect ratio",
    );

export type NewsImage = z.infer<typeof newsImageSchema>;

export type NewsImageRenderingCapability = Readonly<{
    render: (
        input: {
            prompt: string;
            aspectRatio: "4:3";
            style: "narrative-monument" | "pale-watercolor" | "raw-humanism";
        },
        options: { signal: AbortSignal; idempotencyKey: string },
    ) => Promise<NewsImage>;
}>;

export class NewsImageRenderingUnavailable extends Error {
    constructor(options?: ErrorOptions) {
        super("News image rendering is unavailable", options);
        this.name = "NewsImageRenderingUnavailable";
    }
}

export function parseNewsImage(value: unknown): NewsImage {
    return newsImageSchema.parse(value);
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
