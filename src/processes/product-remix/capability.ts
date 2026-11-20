/** 定义商品做同款改图与产物上传的 Business Capability 接口及受控失败分类。 */
import { z } from "zod";
import {
    productRemixImageUrlSchema,
    type RemixEditSize,
    remixEditSizes,
} from "./contract.js";

export const remixEditRequestSchema = z.strictObject({
    images: z
        .array(
            z.strictObject({
                data: z
                    .string()
                    .regex(/^[A-Za-z0-9+/]+=*$/u)
                    .max(20_000_000),
                mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
            }),
        )
        .min(1)
        .max(10),
    prompt: z.string().min(1).max(30_000),
    size: z.enum(remixEditSizes),
    idempotencyKey: z.string().min(1).max(128),
});

export const remixEditResponseSchema = z.strictObject({
    image: z
        .string()
        .regex(/^[A-Za-z0-9+/]+=*$/u)
        .max(28_000_000),
    width: z.int().positive().max(4_096),
    height: z.int().positive().max(4_096),
    modelName: z.string().min(1).max(128),
});

export const remixUploadRequestSchema = z.strictObject({
    image: z
        .string()
        .regex(/^[A-Za-z0-9+/]+=*$/u)
        .max(28_000_000),
});

export const remixUploadedImageSchema = z.strictObject({
    url: productRemixImageUrlSchema,
    width: z.int().positive().max(4_096),
    height: z.int().positive().max(4_096),
});

export type ProductRemixCapabilityFailure = "rejected" | "unknown" | "upload";

export class ProductRemixCapabilityError extends Error {
    constructor(readonly reason: ProductRemixCapabilityFailure) {
        super(
            reason === "rejected"
                ? "图片服务明确拒绝了本次改图"
                : reason === "unknown"
                  ? "改图结果未知"
                  : "成图上传失败",
        );
        this.name = "ProductRemixCapabilityError";
    }

    static fromResponse(
        reason: unknown,
        fallback: ProductRemixCapabilityFailure,
    ) {
        return new ProductRemixCapabilityError(
            reason === "rejected" || reason === "unknown" || reason === "upload"
                ? reason
                : fallback,
        );
    }
}

export type ProductRemixEditRequest = Readonly<{
    images: readonly Readonly<{
        bytes: Buffer;
        mimeType: "image/png" | "image/jpeg" | "image/webp";
    }>[];
    prompt: string;
    size: RemixEditSize;
    idempotencyKey: string;
    signal: AbortSignal;
}>;

export type ProductRemixEditResult = Readonly<{
    bytes: Buffer;
    width: number;
    height: number;
    modelName: string;
}>;

export type ProductRemixUploadedImage = z.infer<
    typeof remixUploadedImageSchema
>;

export type ProductRemixCapability = Readonly<{
    edit(request: ProductRemixEditRequest): Promise<ProductRemixEditResult>;
    upload(
        image: Buffer,
        signal: AbortSignal,
    ): Promise<ProductRemixUploadedImage>;
}>;
