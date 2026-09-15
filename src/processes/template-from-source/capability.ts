/** 定义换图生产的两次审核、不可变产物和内部持久化接口。 */
import { z } from "zod";
import { sourcePhotoSchema } from "../photo-poster/capability.js";
export const templateImageSizes = [
    "1024x1024",
    "1152x896",
    "896x1152",
    "768x1344",
    "1344x768",
] as const;
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const productionIdSchema = z.string().uuid();
export const approvalSchema = z.strictObject({
    productionId: productionIdSchema,
    objectSha256: digestSchema,
    reviewerRef: z.string().trim().min(1).max(191),
});
export const imageApprovalSchema = approvalSchema.extend({
    reviewPackageSha256: digestSchema,
});
export const preparedTemplateImageSchema = z.strictObject({
    url: sourcePhotoSchema,
    sha256: digestSchema,
    width: z.int().min(64).max(4096),
    height: z.int().min(64).max(4096),
    contentType: z.literal("image/png"),
});
export const imageReviewSchema = z.strictObject({
    productionId: productionIdSchema,
    imageSha256: digestSchema,
    reviewPackageSha256: digestSchema,
    width: z.int().min(64).max(4096),
    height: z.int().min(64).max(4096),
    imageDataUrl: z
        .string()
        .max(28000000)
        .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
});
export const finalizedTemplateImageSchema = preparedTemplateImageSchema.extend({
    note: z.string().max(500).optional(),
});
export type PreparedTemplateImage = z.infer<typeof preparedTemplateImageSchema>;
export type StrategyApproval = z.infer<typeof approvalSchema>;
export type ImageApproval = z.infer<typeof imageApprovalSchema>;
export type TemplateImagePreparation = {
    savePlan(input: unknown, signal: AbortSignal): Promise<unknown>;
    render(input: StrategyApproval, signal: AbortSignal): Promise<unknown>;
    finalize(
        input: ImageApproval,
        signal: AbortSignal,
    ): Promise<PreparedTemplateImage & { note?: string }>;
};
export const preparationFailureMessages = {
    provider_rejected:
        "图片服务已明确拒绝，本次批准已消费；请核对服务配置后重新规划和确认",
    submission_unknown: "生成提交结果未知，必须核对供应商记录，禁止重新提交",
    reapproval_required: "方案执行合同已更新，请重新规划和确认",
    incomplete: "成图未完成；请恢复同一生产项，不自动重新付费",
} as const;
export type PreparationFailure = keyof typeof preparationFailureMessages;
export const preparationFailureSchema = z.enum([
    "provider_rejected",
    "submission_unknown",
    "reapproval_required",
    "incomplete",
]);
export class TemplateImagePreparationError extends Error {
    constructor(
        readonly committed: boolean,
        readonly reason: PreparationFailure = "incomplete",
    ) {
        super(preparationFailureMessages[reason]);
    }
}
