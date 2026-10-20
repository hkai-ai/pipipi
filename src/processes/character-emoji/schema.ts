/** schema.ts：移植 Memebuy AI 角色表情包的固定规则与校验。 */
import { z } from "zod";

import { characters } from "./catalog.js";
import type { Composition as LegacyComposition } from "./legacy-schema.js";
import {
    briefSchema as legacyBriefSchema,
    submissionSchema as legacySubmissionSchema,
    emojiTaskContextSchema as legacyTaskContextSchema,
} from "./legacy-schema.js";

export const MAX_CAST = 5;
// 提示词中的短目标用于控制文风；运行时上限只防止异常膨胀，不截断创意。
export const PLAN_TEXT_LIMITS = {
    joke: 240,
    expression: 90,
    action: 180,
    position: 60,
    composition: 240,
    punchlineDetail: 180,
} as const;
const characterSchema = z.enum(characters.map((item) => item.id));
export const castMemberSchema = z
    .object({
        character: characterSchema,
        appearance: z.enum(["Chibi", "Girl"]),
    })
    .strict();
export type CastMember = z.infer<typeof castMemberSchema>;
export const castSchema = z
    .array(castMemberSchema)
    .min(1)
    .max(MAX_CAST)
    .refine(
        (cast) =>
            new Set(cast.map((member) => member.character)).size ===
            cast.length,
        "同一角色只能登场一次",
    );
export const captionSettingSchema = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto") }).strict(),
    z
        .object({
            mode: z.literal("custom"),
            text: z.string().trim().min(1).max(28),
        })
        .strict(),
    z.object({ mode: z.literal("none") }).strict(),
]);
const draftCaptionSettingSchema = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto") }).strict(),
    z.object({ mode: z.literal("custom"), text: z.string().max(28) }).strict(),
    z.object({ mode: z.literal("none") }).strict(),
]);
export const briefSchema = z
    .object({
        cast: castSchema,
        idea: z.string().trim().min(1).max(200),
        // 旧任务不补默认值，保留未知提交的正文与原有文字语义。
        captionSetting: captionSettingSchema.optional(),
    })
    .strict();
export type Brief = z.infer<typeof briefSchema>;
export const COMIC_IDEA_LIMIT = 800;
// 仅用于读取 v4 任务；新漫画的布局由构思方案决定。
export const legacyComicLayouts = [
    {
        value: "vertical-4",
        label: "竖排四格",
        size: "1024x2048",
        aspectRatio: 0.5,
    },
    { value: "grid-4", label: "田字四格", size: "1536x1536", aspectRatio: 1 },
] as const;
export const legacyComicBriefSchema = z
    .object({
        mode: z.literal("comic"),
        layout: z.enum(["vertical-4", "grid-4"]),
        cast: castSchema,
        idea: z.string().trim().min(1).max(COMIC_IDEA_LIMIT),
        captionSetting: z.never().optional(),
    })
    .strict();
export const comicBriefSchema = legacyComicBriefSchema.omit({ layout: true });
export type ComicBrief = z.infer<typeof comicBriefSchema>;
export type LegacyComicBrief = z.infer<typeof legacyComicBriefSchema>;
export type CreationBrief = Brief | ComicBrief;
export const creationBriefSchema = z.union([briefSchema, comicBriefSchema]);
export function isComicBrief(brief: CreationBrief): brief is ComicBrief {
    return "mode" in brief && brief.mode === "comic";
}
export const legacyComicLayout = (brief: LegacyComicBrief) => {
    const layout = legacyComicLayouts.find(
        (candidate) => candidate.value === brief.layout,
    );
    if (!layout) throw new Error("未识别的旧漫画布局");
    return layout;
};
// 画幅是生图能力边界，不是分格模板；格子位置、大小与阅读顺序由模型设计。
export const comicCanvases = {
    "1:1": { size: "1536x1536", aspectRatio: 1 },
    "2:3": { size: "1024x1536", aspectRatio: 2 / 3 },
    "3:2": { size: "1536x1024", aspectRatio: 3 / 2 },
    "1:2": { size: "1024x2048", aspectRatio: 0.5 },
    "2:1": { size: "2048x1024", aspectRatio: 2 },
} as const;
export const initialBrief: Brief = {
    cast: [{ character: "DeepSeek", appearance: "Chibi" }],
    idea: "",
};
export const draftBriefSchema = z
    .union([
        comicBriefSchema.extend({ idea: z.string().max(COMIC_IDEA_LIMIT) }),
        legacyComicBriefSchema
            .extend({ idea: z.string().max(COMIC_IDEA_LIMIT) })
            .transform(({ layout: _layout, ...brief }) => brief),
        briefSchema.extend({
            idea: z.string().max(200),
            captionSetting: draftCaptionSettingSchema.optional(),
        }),
        legacyBriefSchema.extend({ idea: z.string().max(200) }),
    ])
    .transform(
        (brief): CreationBrief =>
            "cast" in brief
                ? brief
                : {
                      cast: [
                          {
                              character: brief.character,
                              appearance: brief.appearance,
                          },
                      ],
                      idea: brief.idea,
                  },
    );

export const textMarkSchema = z
    .object({
        text: z.string().trim().min(1).max(40),
        carrier: z.string().trim().min(1).max(30),
        placement: z.string().trim().min(1).max(30),
    })
    .strict();
export const planSchema = z
    .object({
        caption: z.string().trim().max(28),
        joke: z.string().trim().min(1).max(PLAN_TEXT_LIMITS.joke),
        actors: z
            .array(
                z
                    .object({
                        character: characterSchema,
                        expression: z
                            .string()
                            .trim()
                            .min(1)
                            .max(PLAN_TEXT_LIMITS.expression),
                        action: z
                            .string()
                            .trim()
                            .min(1)
                            .max(PLAN_TEXT_LIMITS.action),
                        position: z
                            .string()
                            .trim()
                            .min(1)
                            .max(PLAN_TEXT_LIMITS.position),
                        identityMark: textMarkSchema.nullable(),
                    })
                    .strict(),
            )
            .min(1)
            .max(MAX_CAST),
        // 旧方案不补默认值，避免改变未知提交的幂等正文。
        propMarks: z.array(textMarkSchema).max(2).optional(),
        composition: z.string().trim().min(1).max(PLAN_TEXT_LIMITS.composition),
        punchlineDetail: z
            .string()
            .trim()
            .min(1)
            .max(PLAN_TEXT_LIMITS.punchlineDetail),
    })
    .strict();
export type EmojiPlan = z.infer<typeof planSchema>;
// 两种 kind 不重叠；普通联合生成 Responses 支持的 anyOf，保留原业务校验。
export const comicTextSchema = z.union([
    z
        .object({
            kind: z.literal("dialogue"),
            speaker: characterSchema,
            text: z.string().trim().min(1).max(40),
            placement: z.string().trim().min(1).max(60),
        })
        .strict(),
    z
        .object({
            kind: z.enum(["narration", "sign"]),
            speaker: z.null(),
            text: z.string().trim().min(1).max(60),
            placement: z.string().trim().min(1).max(60),
        })
        .strict(),
]);
export const legacyComicPlanSchema = z
    .object({
        joke: z.string().trim().min(1).max(240),
        continuity: z.string().trim().min(1).max(600),
        panels: z
            .array(
                z
                    .object({
                        index: z.number().int().min(1).max(4),
                        actors: planSchema.shape.actors,
                        composition: z.string().trim().min(1).max(320),
                        texts: z.array(comicTextSchema).max(3),
                        punchlineDetail: z.string().trim().min(1).max(240),
                    })
                    .strict(),
            )
            .length(4),
    })
    .strict();
export const comicPlanSchema = legacyComicPlanSchema.extend({
    page: z
        .object({
            aspectRatio: z.enum(["1:1", "2:3", "3:2", "1:2", "2:1"]),
            layout: z.string().trim().min(1).max(600),
            readingOrder: z.string().trim().min(1).max(180),
        })
        .strict(),
    panels: z
        .array(
            legacyComicPlanSchema.shape.panels.element.extend({
                index: z.number().int().min(1).max(6),
                frame: z.string().trim().min(1).max(180),
            }),
        )
        .min(2)
        .max(6),
});
export type ComicPlan = z.infer<typeof comicPlanSchema>;
export const comicCanvas = (plan: {
    page: Pick<ComicPlan["page"], "aspectRatio">;
}) => comicCanvases[plan.page.aspectRatio];
export function comicPlanMatchesCast(
    brief: ComicBrief,
    plan: {
        panels: Array<{
            index: number;
            actors: Array<{ character: string }>;
            texts: Array<{ kind: string; speaker: string | null }>;
        }>;
    },
) {
    const selected = new Set<string>(
        brief.cast.map((member) => member.character),
    );
    const appeared = new Set<string>();
    return (
        plan.panels.every((panel, index) => {
            const actors = new Set(
                panel.actors.map((actor) => actor.character),
            );
            for (const actor of actors) appeared.add(actor);
            return (
                panel.index === index + 1 &&
                actors.size === panel.actors.length &&
                [...actors].every((actor) => selected.has(actor)) &&
                panel.texts.every(
                    (text) =>
                        text.kind !== "dialogue" ||
                        (text.speaker !== null && actors.has(text.speaker)),
                )
            );
        }) && [...selected].every((actor) => appeared.has(actor))
    );
}
export function planMatchesCast(
    brief: Brief,
    plan: { actors: Array<{ character: string }> },
) {
    const actors = new Set(plan.actors.map((actor) => actor.character));
    return (
        brief.cast.length === plan.actors.length &&
        actors.size === plan.actors.length &&
        brief.cast.every((member) => actors.has(member.character))
    );
}
export const sceneFromPlan = (plan: EmojiPlan) =>
    [
        ...plan.actors.map(
            (actor) =>
                `${actor.character}：${actor.position}，${actor.expression}，${actor.action}`,
        ),
        plan.composition,
        plan.punchlineDetail,
    ].join("；");
const compositionObjectSchema = z
    .object({
        brief: briefSchema,
        plan: planSchema,
        caption: z.string().trim().max(28),
        scene: z.string().trim().min(1).max(2400),
    })
    .strict();
const matchingCast = ({
    brief,
    plan,
}: z.infer<typeof compositionObjectSchema>) => planMatchesCast(brief, plan);
export const compositionSchema = compositionObjectSchema.refine(
    matchingCast,
    "构思角色必须与登场角色身份一致且不重复",
);
export type Composition = z.infer<typeof compositionSchema>;
export const submissionSchema = z.union([
    z.object({ brief: comicBriefSchema, submissionId: z.uuid() }).strict(),
    z
        .object({ brief: legacyComicBriefSchema, submissionId: z.uuid() })
        .strict(),
    z.object({ brief: briefSchema, submissionId: z.uuid() }).strict(),
    compositionObjectSchema
        .extend({ submissionId: z.uuid() })
        .refine(matchingCast, "构思角色与选择不一致"),
    legacySubmissionSchema,
]);
export type Submission = z.infer<typeof submissionSchema>;
export const historySchema = z.object({ cursor: z.string().min(1).optional() });
export const taskSchema = z.object({ taskId: z.string().min(1) });
// v3 为待构思任务；Worker 完成构思后落为既有 v2 方案快照。
export const pendingEmojiContextSchema = z
    .object({
        version: z.literal(3),
        maker: z.literal("ai-character-emoji"),
        promptVersion: z.string().min(1),
        brief: briefSchema,
    })
    .strict();
const legacyComicContextBase = z
    .object({
        version: z.literal(4),
        maker: z.literal("ai-character-emoji"),
        promptVersion: z.string().min(1),
        brief: legacyComicBriefSchema,
    })
    .strict();
export const legacyComicTaskContextSchema = z
    .discriminatedUnion("phase", [
        legacyComicContextBase.extend({ phase: z.literal("planning") }),
        legacyComicContextBase.extend({
            phase: z.literal("planned"),
            plan: legacyComicPlanSchema,
        }),
    ])
    .refine(
        (context) =>
            context.phase === "planning" ||
            comicPlanMatchesCast(context.brief, context.plan),
        "漫画分镜与登场角色不一致",
    );
export type LegacyComicTaskContext = z.infer<
    typeof legacyComicTaskContextSchema
>;
const comicContextBase = legacyComicContextBase.extend({
    version: z.literal(5),
    brief: comicBriefSchema,
});
export const comicTaskContextSchema = z
    .discriminatedUnion("phase", [
        comicContextBase.extend({ phase: z.literal("planning") }),
        comicContextBase.extend({
            phase: z.literal("planned"),
            plan: comicPlanSchema,
        }),
    ])
    .refine(
        (context) =>
            context.phase === "planning" ||
            comicPlanMatchesCast(context.brief, context.plan),
        "漫画分镜与登场角色不一致",
    );
export type ComicTaskContext = z.infer<typeof comicTaskContextSchema>;
export function comicTaskSize(
    context: ComicTaskContext | LegacyComicTaskContext,
) {
    if (context.version === 4) return legacyComicLayout(context.brief).size;
    return context.phase === "planned"
        ? comicCanvas(context.plan).size
        : undefined;
}
export function normalizeLegacyComicPlan(
    brief: LegacyComicBrief,
    plan: z.infer<typeof legacyComicPlanSchema>,
): ComicPlan {
    const vertical = brief.layout === "vertical-4";
    return {
        ...plan,
        page: {
            aspectRatio: vertical ? "1:2" : "1:1",
            layout: legacyComicLayout(brief).label,
            readingOrder: vertical ? "从上到下" : "左上、右上、左下、右下",
        },
        panels: plan.panels.map((panel) => ({
            ...panel,
            frame: vertical
                ? `从上往下第${panel.index}条横幅`
                : ["左上", "右上", "左下", "右下"][panel.index - 1],
        })),
    };
}
export const emojiTaskContextSchema = z.union([
    comicTaskContextSchema,
    legacyComicTaskContextSchema,
    pendingEmojiContextSchema,
    compositionObjectSchema
        .extend({
            version: z.literal(2),
            maker: z.literal("ai-character-emoji"),
            promptVersion: z.string().min(1),
        })
        .refine(matchingCast, "构思角色与选择不一致"),
    legacyTaskContextSchema,
]);
export function needsEmojiPlanning(
    context: z.infer<typeof emojiTaskContextSchema> | undefined,
) {
    return (
        context?.version === 3 ||
        ((context?.version === 4 || context?.version === 5) &&
            context.phase === "planning")
    );
}

export function isLegacyComposition(
    input: Composition | LegacyComposition,
): input is LegacyComposition {
    return "character" in input.brief;
}
// 只归一化展示与可编辑草稿；未知提交的原始正文和幂等身份必须原样保留。
export function normalizeComposition(
    input: Composition | LegacyComposition,
): Composition {
    if (!isLegacyComposition(input)) return input;
    const { brief, plan, caption, scene } = input;
    return {
        brief: {
            cast: [
                { character: brief.character, appearance: brief.appearance },
            ],
            idea: brief.idea,
        },
        plan: {
            caption: plan.caption,
            joke: plan.joke,
            composition: plan.composition,
            punchlineDetail: plan.punchlineDetail,
            actors: [
                {
                    character: brief.character,
                    expression: plan.expression,
                    action: plan.action,
                    position: "主角",
                    identityMark: plan.identityMark,
                },
            ],
        },
        caption,
        scene,
    };
}
export type EmojiCreation =
    | (Pick<Composition, "brief"> &
          Partial<Omit<Composition, "brief">> & { mode?: never })
    | {
          mode: "comic";
          brief: ComicBrief;
          plan?: ComicPlan;
          caption?: never;
          scene?: never;
      };
export function normalizeCreation(
    input:
        | Composition
        | LegacyComposition
        | { brief: CreationBrief }
        | ComicTaskContext
        | LegacyComicTaskContext,
): EmojiCreation {
    if ("phase" in input)
        return {
            mode: "comic",
            brief: comicBriefSchema.strip().parse(input.brief),
            ...(input.phase === "planned"
                ? {
                      plan:
                          input.version === 4
                              ? normalizeLegacyComicPlan(
                                    input.brief,
                                    input.plan,
                                )
                              : input.plan,
                  }
                : {}),
        };
    if ("plan" in input) return normalizeComposition(input);
    return isComicBrief(input.brief)
        ? { mode: "comic", brief: input.brief }
        : { brief: input.brief };
}
export type EmojiRun = EmojiCreation & {
    taskId: string;
    createdAt: string;
    status: string;
    resultUrl: string | null;
    errorCode: string | null;
};
