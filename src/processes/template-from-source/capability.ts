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
export class TemplateImagePreparationError extends Error {
    constructor(readonly committed: boolean) {
        super("模板图生产未完成");
    }
}
