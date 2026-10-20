/** 校验漫画公开方案的编号、角色与文字合同。 */
import type { AiTextOutputFailure } from "./agent-types.js";

import { textRestrictions } from "./caption-policy.js";
import { readPlannerJson } from "./planner-output.js";
import type { ComicBrief, ComicPlan } from "./schema.js";
import {
    comicPlanMatchesCast,
    comicPlanSchema,
    legacyComicBriefSchema,
} from "./schema.js";

// 仅做无损表示归一化，不补人物、剧情、台词或分格。
function normalizeComicRepresentation(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return value;
    const record = value as Record<string, unknown>;
    const page = record.page;
    if (page && typeof page === "object" && !Array.isArray(page)) {
        const fields = page as Record<string, unknown>;
        if (
            Array.isArray(fields.readingOrder) &&
            fields.readingOrder.length > 0 &&
            fields.readingOrder.every(
                (item) => typeof item === "string" || Number.isInteger(item),
            )
        )
            fields.readingOrder = fields.readingOrder.join(" → ");
    }
    if (Array.isArray(record.panels)) {
        for (const panel of record.panels) {
            if (
                !panel ||
                typeof panel !== "object" ||
                !Array.isArray(panel.actors)
            )
                continue;
            for (const actor of panel.actors) {
                if (
                    actor &&
                    typeof actor === "object" &&
                    !Array.isArray(actor) &&
                    !Object.hasOwn(actor, "identityMark")
                )
                    actor.identityMark = null;
            }
        }
    }
    return record;
}

export function parseComicPlannerOutput(
    text: string,
    brief: ComicBrief,
):
    | { success: true; plan: ComicPlan }
    | ({ success: false } & AiTextOutputFailure) {
    let value: unknown;
    try {
        value = normalizeComicRepresentation(readPlannerJson(text));
    } catch {
        return { success: false, reason: "invalid_json" };
    }
    const parsed = comicPlanSchema.safeParse(value);
    if (!parsed.success)
        return {
            success: false,
            reason: "invalid_schema",
            issues: parsed.error.issues.slice(0, 8).map((issue) => ({
                path: issue.path.join("."),
                code: issue.code,
            })),
        };
    const issues: Array<{ path: string; code: string }> = [];
    // 编号与角色分别检查，避免编号错误遮住角色、对白和文字限制。
    const ordered = {
        ...parsed.data,
        panels: parsed.data.panels.map((panel, index) => ({
            ...panel,
            index: index + 1,
        })),
    };
    if (!comicPlanMatchesCast(brief, ordered))
        issues.push({ path: "panels", code: "comic_cast_mismatch" });
    parsed.data.panels.forEach((panel, index) => {
        if (panel.index !== index + 1)
            issues.push({
                path: `panels.${index}.index`,
                code: "panel_index_mismatch",
            });
    });
    const legacy = legacyComicBriefSchema.safeParse(brief);
    if (
        legacy.success &&
        (parsed.data.panels.length !== 4 ||
            parsed.data.page.aspectRatio !==
                (legacy.data.layout === "vertical-4" ? "1:2" : "1:1"))
    )
        issues.push({ path: "page", code: "legacy_layout_mismatch" });
    const { noText, noDialogue } = textRestrictions(brief.idea);
    if (
        parsed.data.panels.some(
            (panel) =>
                (noText &&
                    (panel.texts.length > 0 ||
                        panel.actors.some((actor) => actor.identityMark))) ||
                (noDialogue &&
                    panel.texts.some((item) => item.kind === "dialogue")),
        )
    ) {
        issues.push({ path: "panels", code: "text_forbidden" });
    }
    return issues.length
        ? { success: false, reason: "invalid_schema", issues }
        : { success: true, plan: parsed.data };
}
