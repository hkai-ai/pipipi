/** 定义每格唯一场景的 v2 合同，校验角色、文字及本次可用的组合素材。 */
import { z } from "zod";
import type { AiTextOutputFailure } from "./agent-types.js";
import { textRestrictions } from "./caption-policy.js";
import { availableMaterialIds } from "./materials.js";
import type { MemeCard } from "./memes.js";
import { readPlannerJson, textRequirementFailure } from "./planner-output.js";
import {
    type Brief,
    type ComicBrief,
    comicPlanMatchesCast,
    comicPlanSchema,
    comicTextSchema,
    MAX_CAST,
    planMatchesCast,
    planSchema,
    textMarkSchema,
} from "./schema.js";
import type { MemeResearch } from "./search.js";

const actors = z
    .array(
        z.strictObject({
            character: planSchema.shape.actors.element.shape.character,
            identityMark: textMarkSchema.nullable(),
        }),
    )
    .min(1)
    .max(MAX_CAST);
export const scenePlanSchema = z.strictObject({
    scene: z.string().trim().min(1).max(1600),
    actors,
    caption: planSchema.shape.caption,
    propMarks: z.array(textMarkSchema).max(2),
});
const panel = z.strictObject({
    scene: z.string().trim().min(1).max(1200),
    actors,
    texts: z.array(comicTextSchema).max(3),
});
export const sceneComicPlanSchema = z.strictObject({
    page: comicPlanSchema.shape.page,
    panels: z
        .array(
            panel.extend({
                index: z.number().int().min(1).max(6),
                frame: z.string().trim().min(1).max(180),
            }),
        )
        .min(2)
        .max(6),
});
export type ScenePlan = z.infer<typeof scenePlanSchema>;
export type SceneComicPlan = z.infer<typeof sceneComicPlanSchema>;
const adaptationSchema = z.strictObject({
    entryIds: z.array(z.string()).max(2),
    original: z.string().trim().min(1).max(400),
});
const singleCandidate = scenePlanSchema.extend({
    adaptation: adaptationSchema,
});
const comicCandidate = z.strictObject({
    page: sceneComicPlanSchema.shape.page,
    panels: z
        .array(sceneComicPlanSchema.shape.panels.element.omit({ index: true }))
        .min(2)
        .max(6),
    adaptation: adaptationSchema,
});
export type SceneCandidate =
    | z.infer<typeof singleCandidate>
    | z.infer<typeof comicCandidate>;
export function sceneCandidateSchema(
    mode: "single" | "comic",
    research: readonly MemeResearch[],
    local: readonly MemeCard[] = [],
) {
    const ids = availableMaterialIds(local, research);
    return (mode === "single" ? singleCandidate : comicCandidate).extend({
        adaptation: adaptationSchema.extend({
            entryIds: z
                .array(ids.length ? z.enum(ids) : z.string())
                .max(ids.length ? 2 : 0),
        }),
    });
}
export function acceptSceneCandidate(
    raw: unknown,
    mode: "single" | "comic",
    research: readonly MemeResearch[],
    local: readonly MemeCard[] = [],
): SceneCandidate {
    return sceneCandidateSchema(mode, research, local).parse(raw);
}
export function projectSceneCandidate(
    candidate: SceneCandidate,
): ScenePlan | SceneComicPlan {
    if ("panels" in candidate)
        return {
            page: candidate.page,
            panels: candidate.panels.map((panel, index) => ({
                ...panel,
                index: index + 1,
            })),
        };
    const { adaptation: _adaptation, ...plan } = candidate;
    return plan;
}
type PlanResult<T> =
    | { success: true; plan: T }
    | ({ success: false } & AiTextOutputFailure);
function read<T>(text: string, schema: z.ZodType<T>): PlanResult<T> {
    let raw: unknown;
    try {
        raw = readPlannerJson(text);
    } catch {
        return { success: false, reason: "invalid_json" };
    }
    const parsed = schema.safeParse(raw);
    return parsed.success
        ? { success: true, plan: parsed.data }
        : {
              success: false,
              reason: "invalid_schema",
              issues: parsed.error.issues.slice(0, 8).map((issue) => ({
                  path: issue.path.join("."),
                  code: issue.code,
              })),
          };
}
export function parseScenePlan(
    text: string,
    brief: Brief,
): PlanResult<ScenePlan> {
    const result = read(text, scenePlanSchema);
    if (!result.success) return result;
    if (!planMatchesCast(brief, result.plan))
        return {
            success: false,
            reason: "invalid_schema",
            issues: [{ path: "actors", code: "cast_mismatch" }],
        };
    const failure = textRequirementFailure(brief, result.plan);
    return failure ? { success: false, ...failure } : result;
}
export function parseSceneComicPlan(
    text: string,
    brief: ComicBrief,
): PlanResult<SceneComicPlan> {
    const result = read(text, sceneComicPlanSchema);
    if (!result.success) return result;
    if (!comicPlanMatchesCast(brief, result.plan))
        return {
            success: false,
            reason: "invalid_schema",
            issues: [{ path: "panels", code: "comic_cast_mismatch" }],
        };
    const { noText, noDialogue } = textRestrictions(brief.idea);
    if (
        result.plan.panels.some(
            (panel) =>
                (noText &&
                    (panel.texts.length > 0 ||
                        panel.actors.some((actor) => actor.identityMark))) ||
                (noDialogue &&
                    panel.texts.some((text) => text.kind === "dialogue")),
        )
    )
        return {
            success: false,
            reason: "invalid_schema",
            issues: [{ path: "panels", code: "text_forbidden" }],
        };
    return result;
}
