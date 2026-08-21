/** News Image Rendering Capability 的图片/生成参数契约 */
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

const generationParameterSchema = z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
]);

export const newsImageGenerationSchema = z.strictObject({
    imageProvider: z.string().trim().min(1).max(100),
    imageModel: z.string().trim().min(1).max(200),
    aspectRatio: z.literal("4:3"),
    width: z.literal(1_600),
    height: z.literal(1_200),
    quality: z.enum(["low", "medium", "high", "auto"]),
    outputFormat: z.literal("png"),
    numImages: z.literal(1),
    seed: z.int().nullable(),
    otherParams: z.record(z.string(), generationParameterSchema),
});

export type NewsImageGeneration = z.infer<typeof newsImageGenerationSchema>;

export type NewsImageStyle =
    | "narrative-monument"
    | "pale-watercolor"
    | "raw-humanism";

export const newsImageRenderingResultSchema = z.strictObject({
    image: newsImageSchema,
    generation: newsImageGenerationSchema,
});

export type NewsImageRenderingResult = z.infer<
    typeof newsImageRenderingResultSchema
>;

export type NewsImageRenderingCapability = Readonly<{
    render: (
        input: {
            prompt: string;
            aspectRatio: "4:3";
            style: NewsImageStyle;
        },
        options: { signal: AbortSignal; idempotencyKey: string },
    ) => Promise<NewsImageRenderingResult>;
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

export function parseNewsImageRenderingResult(
    value: unknown,
): NewsImageRenderingResult {
    return newsImageRenderingResultSchema.parse(value);
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
