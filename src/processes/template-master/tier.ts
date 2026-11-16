/** 由原图状况确定母版起始档位与升档顺序，不看像素清晰度。 */
import type { z } from "zod";
import type { sourceConditionSchema } from "../template-from-image/design-spec/contract.js";
import type { MasterTier } from "./contract.js";
import { GENERATED_TIER_TRIES } from "./thresholds.js";

export type SourceCondition = z.infer<typeof sourceConditionSchema>;

/**
 * 重：载体是实拍（衣服、商品、场景）或严重模糊；轻：无标记、清晰、无压缩痕迹的平面稿；其余为中。
 * 该档位同时是起始档：轻档不过再升中、重，中档不过升重，重档只在本档重试。
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

/** 按顺序列出所有计划内的尝试；轻档确定性，只试一次。 */
export function attemptPlan(start: MasterTier): readonly MasterTier[] {
    const plan: MasterTier[] = [];
    if (start === "light") plan.push("light");
    if (start !== "heavy")
        for (let i = 0; i < GENERATED_TIER_TRIES; i++) plan.push("medium");
    for (let i = 0; i < GENERATED_TIER_TRIES; i++) plan.push("heavy");
    return plan;
}
