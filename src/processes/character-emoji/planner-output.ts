/** planner-output.ts：移植 Memebuy AI 角色表情包的固定规则与校验。 */

import type { AiTextOutputFailure } from "./agent-types.js";

import { textPolicy } from "./caption-policy.js";
import type { Brief, EmojiPlan } from "./schema.js";
import { planMatchesCast, planSchema } from "./schema.js";

type PlanOutput =
    | { success: true; plan: EmojiPlan }
    | ({ success: false } & AiTextOutputFailure);

// 只解开完整 JSON 的单层围栏；分析正文、截断内容不能通过片段提取补救。
export function readPlannerJson(text: string): unknown {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
    return JSON.parse(fenced ? fenced[1] : trimmed);
}

// 标识本就可为空；只统一模型省略空标识的表示，不补造角色或动作。
function normalizeOptionalMarks(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return value;
    const actors = (value as Record<string, unknown>).actors;
    if (Array.isArray(actors)) {
        for (const actor of actors) {
            if (
                actor &&
                typeof actor === "object" &&
                !Array.isArray(actor) &&
                !Object.hasOwn(actor, "identityMark")
            )
                actor.identityMark = null;
        }
    }
    return value;
}

export function textRequirementFailure(
    brief: Brief,
    plan: {
        caption: string;
        actors: Array<{ identityMark: unknown }>;
        propMarks?: readonly unknown[];
    },
): AiTextOutputFailure | null {
    const { noText, setting } = textPolicy(brief);
    if (noText) {
        return plan.caption ||
            plan.actors.some((actor) => actor.identityMark) ||
            plan.propMarks?.length
            ? {
                  reason: "invalid_schema",
                  issues: [{ path: "caption", code: "text_forbidden" }],
              }
            : null;
    }
    if (setting) {
        const mismatch =
            setting.mode === "custom"
                ? plan.caption !== setting.text
                : setting.mode === "none"
                  ? plan.caption !== ""
                  : plan.caption === "";
        return mismatch
            ? {
                  reason: "invalid_schema",
                  issues: [
                      { path: "caption", code: "caption_setting_mismatch" },
                  ],
              }
            : null;
    }
    // 只处理明确、无歧义的写法；复杂自然语言仍由构思提示词和质量评测负责。
    const literal = /^(?:台词|配字)\s*[：:]\s*([^\r\n]+)$/.exec(
        brief.idea.trim(),
    );
    if (literal) {
        const caption = literal[1].replace(/^[“「『"](.*)[”」』"]$/, "$1");
        if (plan.caption !== caption)
            return {
                reason: "invalid_schema",
                issues: [
                    { path: "caption", code: "specified_caption_mismatch" },
                ],
            };
    }
    return null;
}

export function parsePlannerOutput(text: string, brief: Brief): PlanOutput {
    let value: unknown;
    try {
        value = normalizeOptionalMarks(readPlannerJson(text));
    } catch {
        return { success: false, reason: "invalid_json" };
    }
    const parsed = planSchema.safeParse(value);
    if (!parsed.success)
        return {
            success: false,
            reason: "invalid_schema",
            issues: parsed.error.issues.slice(0, 8).map((issue) => ({
                path: issue.path.join(".") || "$",
                code: issue.code,
            })),
        };
    if (!planMatchesCast(brief, parsed.data))
        return {
            success: false,
            reason: "invalid_schema",
            issues: [{ path: "actors", code: "cast_mismatch" }],
        };
    const failure = textRequirementFailure(brief, parsed.data);
    if (failure) return { success: false, ...failure };
    return { success: true, plan: parsed.data };
}
