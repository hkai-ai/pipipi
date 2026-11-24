/** 定义商品做同款（product-remix/v1）输入输出契约、公网原图 URL 红线校验与尺寸映射。 */
import { isIP } from "node:net";
import { z } from "zod";
import { isPublicSourceImageUrl } from "../crt/capability.js";

export const remixEditSizes = [
    "1024x1024",
    "896x1152",
    "1152x896",
    "768x1344",
    "1344x768",
] as const;

export type RemixEditSize = (typeof remixEditSizes)[number];

export const remixTiers = ["light", "medium", "heavy"] as const;

export type RemixTier = (typeof remixTiers)[number];

/** 严格校验收敛的公网原图 HTTPS URL：无端口、无凭证、无锚点、非 IP/localhost、不含 x-oss-process。 */
export function isProductRemixImageUrl(value: string): boolean {
    if (value.length === 0 || value.length > 2_048 || value.includes("#")) {
        return false;
    }
    if (!isPublicSourceImageUrl(value)) return false;
    const authority =
        value.slice("https://".length).split(/[/?#]/u, 1)[0] ?? "";
    if (!authority || authority.includes(":") || authority.includes("@")) {
        return false;
    }
    try {
        const url = new URL(value);
        if (isIP(url.hostname) !== 0) return false;
        for (const key of url.searchParams.keys()) {
            if (key.toLowerCase() === "x-oss-process") return false;
        }
        if (/[?&]x-oss-process(?:=|&|$)/iu.test(url.search)) return false;
        return true;
    } catch {
        return false;
    }
}

export const productRemixImageUrlSchema = z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .refine(
        isProductRemixImageUrl,
        "图片地址必须是无端口、无凭证、无锚点、不含 x-oss-process 的公网 HTTPS 原图 URL",
    )
    .meta({
        format: "uri",
        description:
            "公网原图 HTTPS URL（最长 2048 字符，禁止 IP/localhost、显式端口、凭据、# 片段及 x-oss-process 查询参数）。",
    });

export function parseImageSize(
    value: string,
): Readonly<{ width: number; height: number }> | undefined {
    const match = /^([1-9]\d{1,3})[xX]([1-9]\d{1,3})$/u.exec(value.trim());
    if (!match?.[1] || !match[2]) return undefined;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 64 ||
        height < 64 ||
        width > 8_192 ||
        height > 8_192
    ) {
        return undefined;
    }
    return { width, height };
}

export function selectRemixImageSize(
    dimensions: Readonly<{ width: number; height: number }>,
): RemixEditSize {
    const exact = `${dimensions.width}x${dimensions.height}`;
    if ((remixEditSizes as readonly string[]).includes(exact)) {
        return exact as RemixEditSize;
    }
    const ratio = dimensions.width / dimensions.height;
    const distance = (size: RemixEditSize) => {
        const [w, h] = size.split("x").map(Number);
        return Math.abs(Math.log(ratio / ((w ?? 1) / (h ?? 1))));
    };
    return remixEditSizes.reduce((best, candidate) =>
        distance(candidate) < distance(best) ? candidate : best,
    );
}

export const productRemixBudgetSchema = z.strictObject({
    maxAttempts: z
        .int()
        .min(1)
        .max(10)
        .describe("最大生成与质检尝试次数（1–10）。"),
    maxUsd: z
        .number()
        .positive()
        .max(20)
        .describe("本次运行的 USD 费用上限（> 0 且 <= 20）。"),
});

export type ProductRemixBudget = z.infer<typeof productRemixBudgetSchema>;

export const productRemixInputSchema = z
    .strictObject({
        sourceImageUrl: productRemixImageUrlSchema.describe(
            "图 1：当前商品印制面印花原图，唯一视觉风格与版式基准。",
        ),
        referenceImageUrl: productRemixImageUrlSchema
            .optional()
            .describe("可选单张用户参考图 URL，与 referenceImageUrls 互斥。"),
        referenceImageUrls: z
            .array(productRemixImageUrlSchema)
            .max(9)
            .optional()
            .describe(
                "可选 0–9 张按上传顺序排列的用户参考图 URL，与 referenceImageUrl 互斥。",
            ),
        userText: z
            .string()
            .trim()
            .min(1)
            .max(2_000)
            .describe("已过出站文本审核的用户编辑意图（1–2000 字符）。"),
        imageSize: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .refine(
                (value) => parseImageSize(value) !== undefined,
                "imageSize 必须为合法的 WxH 尺寸格式（如 1024x1024）",
            )
            .optional()
            .meta({
                pattern: "^[1-9]\\d{1,3}[xX][1-9]\\d{1,3}$",
                description:
                    "可选目标尺寸 WxH（宽高各 64–8192 像素，如 1024x1024、896x1152），将匹配最接近的正典尺寸；省略时按原图宽高比选择。",
            }),
        budget: productRemixBudgetSchema,
    })
    .refine(
        (input) => !(input.referenceImageUrl && input.referenceImageUrls),
        "参考图字段重复",
    )
    .meta({
        description:
            "商品做同款严格输入；referenceImageUrl 与 referenceImageUrls 互斥，不能同时传入。",
        not: { required: ["referenceImageUrl", "referenceImageUrls"] },
    });

export type ProductRemixInput = z.infer<typeof productRemixInputSchema>;

export const productRemixOutputSchema = z.strictObject({
    image: z.strictObject({
        url: productRemixImageUrlSchema.describe(
            "成图公网原图 HTTPS URL；直取 200 无重定向，且严禁回显任何输入图 URL。",
        ),
        width: z.int().positive().max(4_096),
        height: z.int().positive().max(4_096),
    }),
    modelName: z
        .string()
        .min(1)
        .max(128)
        .describe("实际采纳成图的图像模型标识。"),
    resolvedTier: z
        .enum(remixTiers)
        .describe(
            "服务端 Agent 自动判定的最终档位（light / medium / heavy）。",
        ),
});

export type ProductRemixOutput = z.infer<typeof productRemixOutputSchema>;
