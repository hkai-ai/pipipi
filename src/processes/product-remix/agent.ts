/** 定义商品做同款的规划与视觉质检 Agent Port、严格输出 Schema 与质检判定函数。 */
import { z } from "zod";
import { type RemixEditSize, remixTiers } from "./contract.js";

export const remixPlanSchema = z.strictObject({
    tier: z.enum(remixTiers),
    rationale: z.string().trim().min(1).max(400),
    editPrompt: z.string().trim().min(20).max(6_000),
    expectedTexts: z.array(z.string().trim().min(1).max(200)).max(20),
    forbiddenTexts: z.array(z.string().trim().min(1).max(200)).max(20),
    keepOriginalStyle: z.boolean(),
});

export type RemixPlan = z.infer<typeof remixPlanSchema>;

export const remixVerificationSchema = z.strictObject({
    intentFollowed: z.boolean(),
    textAccurate: z.boolean(),
    noMockup: z.boolean(),
    notCropped: z.boolean(),
    issues: z.array(z.string().trim().min(1).max(200)).max(8),
});

export type RemixVerification = z.infer<typeof remixVerificationSchema>;

export function evaluateRemixVerification(
    verdict: RemixVerification,
): Readonly<{ passed: boolean; issues: readonly string[] }> {
    const passed =
        verdict.intentFollowed &&
        verdict.textAccurate &&
        verdict.noMockup &&
        verdict.notCropped;
    if (passed) {
        return Object.freeze({ passed: true, issues: Object.freeze([]) });
    }
    const derived: string[] = [];
    if (!verdict.intentFollowed) {
        derived.push(
            "未完整落实用户的核心修改要求，请严格对照修改意图调整画面",
        );
    }
    if (!verdict.textAccurate) {
        derived.push(
            "画面文字内容、拼写或字形有误，请按要求文字列表准确绘制，禁止输出指令原文",
        );
    }
    if (!verdict.noMockup) {
        derived.push(
            "误画出了 T 恤、杯子、衣架或商品实物样机/褶皱，必须仅输出纯平面独立印花图案",
        );
    }
    if (!verdict.notCropped) {
        derived.push("主体或文字贴边/被截断，必须在画布四周留出连续安全留白");
    }
    const merged = [
        ...new Set([
            ...verdict.issues.map((item) => item.trim()).filter(Boolean),
            ...derived,
        ]),
    ];
    return Object.freeze({
        passed: false,
        issues: Object.freeze(merged),
    });
}

export type RemixViewImage = Readonly<{
    data: string;
    mimeType: "image/webp" | "image/png";
}>;

export type ProductRemixPlanRequest = Readonly<{
    sourceView: RemixViewImage;
    referenceViews: RemixViewImage[];
    userText: string;
    targetSize: RemixEditSize;
    canRetry?: () => boolean;
    signal: AbortSignal;
}>;

export type ProductRemixVerifyRequest = Readonly<{
    sourceView: RemixViewImage;
    referenceViews: RemixViewImage[];
    candidateView: RemixViewImage;
    userText: string;
    plan: RemixPlan;
    canRetry?: () => boolean;
    signal: AbortSignal;
}>;

export interface ProductRemixAgent {
    plan(request: ProductRemixPlanRequest): Promise<RemixPlan>;
    verify(request: ProductRemixVerifyRequest): Promise<RemixVerification>;
}
