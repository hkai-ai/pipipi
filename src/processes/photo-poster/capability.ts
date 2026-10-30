/** 照片海报输入输出 Schema 与图片生成能力接口。 */
import { z } from "zod";
import { isPublicSourceImageUrl } from "../crt/capability.js";
import { imageBackgroundSchema } from "../image-background.js";
import { photoPosterStyles } from "./style.js";

export const sourcePhotoSchema = z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .refine(isPublicSourceImageUrl, "参考图必须是公网 HTTPS URL");

export const photoPosterImageSchema = z.strictObject({
    url: z
        .url()
        .max(2_048)
        .refine((value) => {
            const url = new URL(value);
            return (
                ["http:", "https:"].includes(url.protocol) &&
                !url.username &&
                !url.password
            );
        }),
    contentType: z.literal("image/png"),
    width: z.int().min(64).max(4_096),
    height: z.int().min(64).max(12_288),
    expiresAt: z.iso.datetime().optional(),
});

export const photoPosterRenderSchema = z
    .strictObject({
        sourceImageUrl: sourcePhotoSchema,
        background: imageBackgroundSchema.optional(),
        style: z.enum(photoPosterStyles),
        prompt: z.string().trim().min(100).max(16_000),
        archive: z
            .strictObject({
                number: z.int().min(1).max(999),
                date: z.iso.date(),
                phrase: z
                    .string()
                    .regex(/^[A-Z]+(?: [A-Z]+){0,2}$/)
                    .max(60),
            })
            .optional(),
    })
    .refine(
        (value) =>
            (value.style === "travel-abstraction") === Boolean(value.archive),
    );

export type PhotoPosterImage = z.infer<typeof photoPosterImageSchema>;
export type PhotoPosterRenderInput = z.infer<typeof photoPosterRenderSchema>;
export type PhotoPosterRenderingCapability = Readonly<{
    render: (
        input: PhotoPosterRenderInput,
        options: {
            signal: AbortSignal;
            idempotencyKey: string;
        },
    ) => Promise<PhotoPosterImage>;
}>;

export class PhotoPosterRenderingUnavailable extends Error {
    readonly committed: boolean;
    constructor(options: ErrorOptions & { committed?: boolean } = {}) {
        super("照片海报生成服务不可用", options);
        this.name = "PhotoPosterRenderingUnavailable";
        this.committed = options.committed ?? false;
    }
}
