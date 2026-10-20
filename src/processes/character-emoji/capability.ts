/** 表情包图片渲染 Capability 与结果契约。 */
import { z } from "zod";

export const characterEmojiImageSchema = z.strictObject({
    url: z.url().max(2_048),
    contentType: z.literal("image/png"),
    width: z.int().min(64).max(4_096),
    height: z.int().min(64).max(4_096),
});

export const characterEmojiRenderInputSchema = z.strictObject({
    prompt: z.string().trim().min(100).max(16_000),
    imageUrls: z
        .array(z.url().refine(isApprovedCharacterImageUrl))
        .min(1)
        .max(5),
    size: z.enum([
        "1024x1024",
        "1024x1536",
        "1536x1024",
        "1024x2048",
        "2048x1024",
        "1536x1536",
    ]),
});

export type CharacterEmojiRenderingCapability = Readonly<{
    render: (
        input: { prompt: string; imageUrls: readonly string[]; size: string },
        options: { signal: AbortSignal; idempotencyKey: string },
    ) => Promise<z.infer<typeof characterEmojiImageSchema>>;
}>;

export class CharacterEmojiRenderingUnavailable extends Error {
    constructor(
        readonly committed: boolean,
        options?: ErrorOptions,
    ) {
        super("角色表情包图片服务不可用", options);
        this.name = "CharacterEmojiRenderingUnavailable";
    }
}

function isApprovedCharacterImageUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return (
            url.protocol === "https:" &&
            url.hostname === "assets.memebuy.cn" &&
            !url.username &&
            !url.password &&
            url.pathname.startsWith("/maker/characters/ai-fanworks/")
        );
    } catch {
        return false;
    }
}
