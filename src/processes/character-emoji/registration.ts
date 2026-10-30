/** 注册角色表情包的精确版本，统一治理构思、诊断与单次生图。 */
import { z } from "zod";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../../process-runtime/index.js";
import type {
    CharacterEmojiAgent,
    CharacterEmojiBudget,
    SceneEmojiAgent,
} from "./agent.js";
import {
    type CharacterEmojiRenderingCapability,
    CharacterEmojiRenderingUnavailable,
    characterEmojiImageSchema,
} from "./capability.js";
import {
    matchesVersionedCast,
    versionedBriefSchema,
    versionedComicBriefSchema,
    versionedInputSchema,
} from "./cast.js";
import { characters, imageUrl } from "./catalog.js";
import { comicImagePrompt } from "./comic-prompt.js";
import {
    type EmojiDiagnostic,
    type EmojiObservation,
    type EmojiObservationRecord,
    emojiDiagnostic,
} from "./diagnostics.js";
import { imageSizes } from "./image-options.js";
import { imagePrompt } from "./prompt.js";
import {
    sceneComicPlanSchema,
    scenePlanSchema,
    versionedSceneComicPlanSchema,
    versionedScenePlanSchema,
} from "./scene.js";
import { sceneComicImagePrompt, sceneImagePrompt } from "./scene-prompt.js";
import {
    briefSchema,
    type ComicBrief,
    type CreationBrief,
    comicBriefSchema,
    comicPlanSchema,
    isComicBrief,
    planSchema,
    sceneFromPlan,
} from "./schema.js";

const inputSchema = z.union([briefSchema, comicBriefSchema]);
export const characterEmojiBudget: CharacterEmojiBudget = Object.freeze({
    timeoutMs: 120_000,
    searchTimeoutMs: 30_000,
    maxSearchCalls: 1,
    maxKeywords: 2,
    maxModelCalls: 3,
    searchTokens: 4096,
    reasoningEffort: "low",
});
const outputSchema = z.strictObject({
    image: characterEmojiImageSchema,
    mode: z.enum(["single", "comic"]),
    caption: z.string().max(28).optional(),
    plan: z.unknown(),
});
const sceneOutputSchema = outputSchema.extend({
    plan: z.union([scenePlanSchema, sceneComicPlanSchema]),
});

export function createCharacterEmojiRegistration(
    options: {
        capability: CharacterEmojiRenderingCapability;
        onDiagnostic?: (record: EmojiDiagnostic) => void;
        onObservation?: (record: EmojiObservationRecord) => void;
    } & (
        | { version?: "v1"; agent: CharacterEmojiAgent }
        | { version: "v2"; agent: SceneEmojiAgent }
        | { version: "v3"; agent: SceneEmojiAgent }
    ),
): ProcessRegistration {
    if (!options.agent || !options.capability)
        throw new Error("表情包 Process 依赖未配置");
    return defineProcessRegistration({
        id: "character-emoji",
        version: options.version ?? "v1",
        timeoutMs: 480_000,
        inputSchema:
            options.version === "v3" ? versionedInputSchema : inputSchema,
        outputSchema:
            options.version === "v3"
                ? outputSchema.extend({
                      plan: z.union([
                          versionedScenePlanSchema,
                          versionedSceneComicPlanSchema,
                      ]),
                  })
                : options.version === "v2"
                  ? sceneOutputSchema
                  : outputSchema,
        activities: ["character_emoji_planning", "character_emoji_rendering"],
        execute: async (input, context) => {
            const started = Date.now();
            const observe = (record: EmojiObservation) => {
                try {
                    options.onObservation?.({
                        ...record,
                        event: "character_emoji_observation",
                        runId: context.runId,
                    });
                } catch {
                    // 观测失败不改变业务结果或消耗模型预算。
                }
            };
            const comic = isComicBrief(input);
            let plan: unknown;
            let prompt: string;
            let size = "1024x1024";
            try {
                if (comic) {
                    const brief: ComicBrief = (
                        options.version === "v3"
                            ? versionedComicBriefSchema
                            : comicBriefSchema
                    ).parse(input);
                    const compiled = await context.runActivity(
                        "character_emoji_planning",
                        async () => {
                            if (
                                options.version === "v2" ||
                                options.version === "v3"
                            ) {
                                const plan = (
                                    options.version === "v3"
                                        ? versionedSceneComicPlanSchema
                                        : sceneComicPlanSchema
                                ).parse(
                                    await options.agent.planSceneComic(
                                        brief,
                                        context.signal,
                                        characterEmojiBudget,
                                        observe,
                                    ),
                                );
                                if (
                                    options.version === "v3" &&
                                    !matchesVersionedCast(brief, plan.panels)
                                )
                                    throw new Error("漫画登场身份不匹配");
                                return {
                                    plan,
                                    prompt: sceneComicImagePrompt(brief, plan),
                                };
                            }
                            const plan = comicPlanSchema.parse(
                                await options.agent.planComic(
                                    brief,
                                    context.signal,
                                    characterEmojiBudget,
                                    observe,
                                ),
                            );
                            return {
                                plan,
                                prompt: comicImagePrompt(brief, plan),
                            };
                        },
                    );
                    plan = compiled.plan;
                    prompt = compiled.prompt;
                    if (
                        brief.aspectRatio &&
                        compiled.plan.page.aspectRatio !== brief.aspectRatio
                    )
                        throw new Error("漫画画幅与请求不一致");
                    size = imageSizes[compiled.plan.page.aspectRatio];
                } else {
                    const brief = (
                        options.version === "v3"
                            ? versionedBriefSchema
                            : briefSchema
                    ).parse(input);
                    const compiled = await context.runActivity(
                        "character_emoji_planning",
                        async () => {
                            if (
                                options.version === "v2" ||
                                options.version === "v3"
                            ) {
                                const plan = (
                                    options.version === "v3"
                                        ? versionedScenePlanSchema
                                        : scenePlanSchema
                                ).parse(
                                    await options.agent.planScene(
                                        brief,
                                        context.signal,
                                        characterEmojiBudget,
                                        observe,
                                    ),
                                );
                                if (
                                    options.version === "v3" &&
                                    !matchesVersionedCast(brief, [plan])
                                )
                                    throw new Error("表情包登场身份不匹配");
                                return {
                                    plan,
                                    prompt: sceneImagePrompt(brief, plan),
                                };
                            }
                            const plan = planSchema.parse(
                                await options.agent.plan(
                                    brief,
                                    context.signal,
                                    characterEmojiBudget,
                                    observe,
                                ),
                            );
                            return {
                                plan,
                                prompt: imagePrompt({
                                    brief,
                                    plan,
                                    caption: plan.caption,
                                    scene: sceneFromPlan(plan),
                                }),
                            };
                        },
                    );
                    plan = compiled.plan;
                    prompt = compiled.prompt;
                }
            } catch (error) {
                try {
                    options.onDiagnostic?.(
                        emojiDiagnostic(
                            error,
                            context.runId,
                            Date.now() - started,
                            context.signal,
                        ),
                    );
                } catch {
                    // 诊断失败不改变业务结果或消耗模型预算。
                }
                return failProcess(
                    "AGENT_FAILURE",
                    "表情包方案生成失败，请根据运行诊断检查构思阶段",
                );
            }
            context.signal.throwIfAborted();
            const brief: CreationBrief = input;
            if (brief.aspectRatio) size = imageSizes[brief.aspectRatio];
            const imageUrls = brief.cast.map((member) =>
                imageUrl(
                    member.character,
                    member.appearance,
                    options.version === "v3" ? "v3" : "v2",
                ),
            );
            try {
                const image = characterEmojiImageSchema.parse(
                    await context.runActivity("character_emoji_rendering", () =>
                        options.capability.render(
                            {
                                prompt,
                                imageUrls,
                                size,
                                ...(brief.background
                                    ? { background: brief.background }
                                    : {}),
                            },
                            {
                                signal: context.signal,
                                idempotencyKey: context.runId,
                            },
                        ),
                    ),
                );
                const mode: "comic" | "single" = comic ? "comic" : "single";
                return {
                    image,
                    mode,
                    ...(!comic
                        ? {
                              caption: (plan as z.infer<typeof planSchema>)
                                  .caption,
                          }
                        : {}),
                    plan,
                };
            } catch (error) {
                if (error instanceof CharacterEmojiRenderingUnavailable) {
                    return failProcess(
                        error.committed
                            ? "DEPENDENCY_FAILURE_AFTER_COMMIT"
                            : "DEPENDENCY_FAILURE",
                        "表情包生图或交付失败；提交结果不确定时请先核对运行记录",
                    );
                }
                throw error;
            }
        },
    });
}

export const characterEmojiIds = characters.map((character) => character.id);
