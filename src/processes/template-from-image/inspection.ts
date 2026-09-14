/** 绑定独立复核的输入摘要并应用有限补丁，再校验最终报告与候选的对应关系。 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { TemplateContractError } from "./contract.js";
import {
    applyTemplateCorrection,
    templateCorrectionSchema,
} from "./correction.js";
import {
    materializeTemplatePlan,
    type readTemplatePlan,
} from "./projection.js";
import { candidateDigest, templateReviewSchema } from "./quality.js";

export const templateInspectionSchema = z.strictObject({
    reviewedPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
    changes: z.array(templateCorrectionSchema.shape.changes.element).max(64),
    review: templateReviewSchema.omit({ reviewedDraftSha256: true }),
});

export function planDigest(plan: ReturnType<typeof readTemplatePlan>): string {
    return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function applyTemplateInspection(
    plan: ReturnType<typeof readTemplatePlan>,
    value: unknown,
) {
    const parsed = templateInspectionSchema.safeParse(value);
    if (!parsed.success || JSON.stringify(value).length > 100_000)
        throw new TemplateContractError([
            "独立复核必须返回输入摘要、有界补丁及完整的最终复核报告",
        ]);
    if (parsed.data.reviewedPlanSha256 !== planDigest(plan))
        throw new TemplateContractError(["独立复核未绑定本次输入计划摘要"]);
    const updated = parsed.data.changes.length
        ? applyTemplateCorrection(plan, { changes: parsed.data.changes })
        : plan;
    const candidate = materializeTemplatePlan(updated);
    return {
        ...candidate,
        review: {
            ...parsed.data.review,
            reviewedDraftSha256: candidateDigest(candidate),
        },
    };
}
