/** 由原图状况和模板原图证据确定母版起始档位与升档顺序。 */
import type { z } from "zod";
import { normalizePrintText } from "../print-text.js";
import type { sourceConditionSchema } from "../template-from-image/design-spec/contract.js";
import type { MasterTier, ResolvedMasterInput } from "./contract.js";
import { GENERATED_TIER_TRIES } from "./thresholds.js";

export type SourceCondition = z.infer<typeof sourceConditionSchema>;

/**
 * 重：载体是实拍（衣服、商品、场景）或严重模糊；轻：无标记、清晰、无压缩痕迹的平面稿；其余为中。
 * 该档位同时是起始档：轻档只用原图，中档不过升重，重档只在本档重试。
 */
export function startingTier(condition: SourceCondition): MasterTier {
    if (
        condition.carrier !== "flat_artwork" ||
        condition.sharpness === "severely_blurry"
    )
        return "heavy";
    if (
        condition.marks.length === 0 &&
        condition.sharpness === "clear" &&
        !condition.compressionArtifacts
    )
        return "light";
    return "medium";
}

/** 只比较已有的逐字文字和明确的原物名称，缺失证据时沿用状况分档。 */
export function redrawReason(input: ResolvedMasterInput): string | undefined {
    const spec = input.template.runtimeSemantics.designSpec;
    const observed = new Map(
        input.sourceTexts?.map(({ elementId, text }) => [elementId, text]),
    );
    const textMismatch = spec.elements.some((element) => {
        if (element.category !== "text") return false;
        const source = normalizePrintText(
            observed.get(element.id) ?? element.instance ?? "",
        );
        return Boolean(
            source &&
                source !==
                    normalizePrintText(spec.defaults.texts[element.id] ?? ""),
        );
    });
    const subjects = spec.elements.filter(
        (element) => element.category === "subject",
    );
    const subject = subjects.length === 1 ? subjects[0] : undefined;
    const original = normalizePrintText(subject?.originalObject ?? "");
    const expectedSubject = normalizePrintText(spec.defaults.subject);
    const subjectMismatch =
        original &&
        expectedSubject &&
        !expectedSubject.includes(original) &&
        !original.includes(expectedSubject) &&
        expectedSubject !== normalizePrintText(subject?.instance ?? "");
    if (textMismatch && subjectMismatch)
        return "默认文字和主体与原图记录不一致，跳过轻档和中档";
    if (textMismatch) return "默认文字与原图记录不一致，跳过轻档和中档";
    if (subjectMismatch) return "默认主体与原图记录不一致，跳过轻档和中档";
    return undefined;
}

/** 按顺序列出所有计划内的尝试；轻档确定性，只试一次。 */
export function attemptPlan(start: MasterTier): readonly MasterTier[] {
    const plan: MasterTier[] = [];
    if (start === "light") return ["light"];
    if (start !== "heavy")
        for (let i = 0; i < GENERATED_TIER_TRIES; i++) plan.push("medium");
    for (let i = 0; i < GENERATED_TIER_TRIES; i++) plan.push("heavy");
    return plan;
}
