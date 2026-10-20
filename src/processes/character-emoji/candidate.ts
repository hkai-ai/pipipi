/** 定义 Agent 最终候选、验证同次来源，并生成公开方案的编号与布局。 */
import { z } from "zod";
import { fixedComicLayout } from "./comic-layout.js";
import {
    type ComicPlan,
    comicPlanSchema,
    type EmojiPlan,
    planSchema,
} from "./schema.js";
import type { MemeResearch } from "./search.js";

export const adaptationSchema = z.strictObject({
    entryId: z.string().nullable(),
    original: z.string().trim().min(1).max(400),
});
export const singleCandidateSchema = planSchema
    .required()
    .extend({ adaptation: adaptationSchema });
export const comicCandidateSchema = z.strictObject({
    joke: comicPlanSchema.shape.joke,
    continuity: comicPlanSchema.shape.continuity,
    aspectRatio: comicPlanSchema.shape.page.shape.aspectRatio,
    panels: z
        .array(
            comicPlanSchema.shape.panels.element.omit({
                index: true,
                frame: true,
            }),
        )
        .min(2)
        .max(6),
    adaptation: adaptationSchema,
});
export type Candidate =
    | z.infer<typeof singleCandidateSchema>
    | z.infer<typeof comicCandidateSchema>;
export function candidateSchema(
    mode: "single" | "comic",
    research?: readonly MemeResearch[],
) {
    const base =
        mode === "comic" ? comicCandidateSchema : singleCandidateSchema;
    if (!research) return base;
    const ids = [
        ...new Set(
            research.flatMap((item) =>
                item.entries
                    .filter((entry) => entry.kind !== "background")
                    .map((entry) => entry.id),
            ),
        ),
    ];
    return base.extend({
        adaptation: adaptationSchema.extend({
            entryId: ids.length ? z.enum(ids).nullable() : z.null(),
        }),
    });
}

export function validateAdaptation(
    candidate: Pick<Candidate, "adaptation">,
    research: readonly MemeResearch[],
) {
    if (candidate.adaptation.entryId === null) return;
    const entry = research
        .flatMap((item) => item.entries)
        .find((entry) => entry.id === candidate.adaptation.entryId);
    if (!entry || entry.kind === "background")
        throw new Error("改编未绑定可用社区行为");
}

export function acceptCandidate(
    raw: unknown,
    mode: "single" | "comic",
    research: readonly MemeResearch[],
): Candidate {
    const candidate = candidateSchema(mode, research).parse(raw);
    validateAdaptation(candidate, research);
    return candidate;
}

export function projectCandidate(candidate: Candidate): EmojiPlan | ComicPlan {
    if ("panels" in candidate)
        return fixedComicLayout({
            joke: candidate.joke,
            continuity: candidate.continuity,
            page: {
                aspectRatio: candidate.aspectRatio,
                layout: "待投影",
                readingOrder: "待投影",
            },
            panels: candidate.panels.map((panel, index) => ({
                ...panel,
                index: index + 1,
                frame: "待投影",
            })),
        });
    const { adaptation: _adaptation, ...plan } = candidate;
    return plan;
}

export const CANDIDATE_PROMPT = `按请求级Schema提交方案。actors写人物姿势、表情和位置；composition写取景、环境与道具关系；punchlineDetail写可见反差；漫画continuity写跨格保持或改变的内容，编号和布局由程序生成。
台词、身份与品牌标识放在对应文字字段；其他场景短字、数字或符号可随composition描述，非关键环境文字可由绘图模型少量补充；用户禁止文字时全部省略。adaptation.entryId选择采用的社区条目ID，无适合来源时为null；original简述采用的行为关系及原创部分。`;
