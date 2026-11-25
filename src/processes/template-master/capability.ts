/** 定义母版改图与上传的 Business Capability 接口及受控失败分类。 */
import { z } from "zod";
import {
    type ImageBackground,
    imageBackgroundSchema,
} from "../image-background.js";
import type { preparedImageSchema } from "./contract.js";

export const templateMasterV2ImageModel = "gpt-image-2.6-sunburst";
export const masterEditModels = [
    "gpt-image-2.5-flare",
    templateMasterV2ImageModel,
] as const;
export type MasterEditModel = (typeof masterEditModels)[number];

export const masterEditQualities = ["low", "medium", "high", "auto"] as const;
export type MasterEditQuality = (typeof masterEditQualities)[number];

export const masterEditSizes = [
    "1024x1024",
    "1152x896",
    "896x1152",
    "768x1344",
    "1344x768",
] as const;

export const masterEditRequestSchema = z.strictObject({
    image: z
        .string()
        .regex(/^[A-Za-z0-9+/]+=*$/u)
        .max(28_000_000),
    prompt: z.string().min(1).max(30_000),
    size: z.enum(masterEditSizes),
    model: z.enum(masterEditModels).optional(),
    quality: z.enum(masterEditQualities).optional(),
    background: imageBackgroundSchema.optional(),
    idempotencyKey: z.string().min(1).max(128),
});
export const masterEditResponseSchema = z.strictObject({
    image: z
        .string()
        .regex(/^[A-Za-z0-9+/]+=*$/u)
        .max(28_000_000),
});
export const masterUploadRequestSchema = z.strictObject({
    image: z
        .string()
        .regex(/^[A-Za-z0-9+/]+=*$/u)
        .max(28_000_000),
});

/** rejected：图片服务明确拒绝；unknown：已派发但结果未知，费用不可知；upload：上传失败。 */
export type MasterCapabilityFailure = "rejected" | "unknown" | "upload";

export class MasterCapabilityError extends Error {
    constructor(readonly reason: MasterCapabilityFailure) {
        super(
            reason === "rejected"
                ? "图片服务明确拒绝了本次改图"
                : reason === "unknown"
                  ? "改图结果未知"
                  : "母版上传失败",
        );
    }
    static fromResponse(reason: unknown, fallback: MasterCapabilityFailure) {
        return new MasterCapabilityError(
            reason === "rejected" || reason === "unknown" || reason === "upload"
                ? reason
                : fallback,
        );
    }
}

export type MasterEditRequest = Readonly<{
    /** PNG 字节，完整原图（长边可能已缩小），不裁切、不遮挡。 */
    image: Buffer;
    prompt: string;
    size: (typeof masterEditSizes)[number];
    model?: MasterEditModel;
    quality?: MasterEditQuality;
    background?: ImageBackground;
    idempotencyKey: string;
    signal: AbortSignal;
}>;

export type TemplateMasterCapability = {
    /** 单次派发的改图，返回 PNG 字节；失败抛 MasterCapabilityError。 */
    edit(request: MasterEditRequest): Promise<Buffer>;
    /** 按内容寻址上传到模板公读存储。 */
    upload(
        image: Buffer,
        signal: AbortSignal,
    ): Promise<z.infer<typeof preparedImageSchema>>;
};
