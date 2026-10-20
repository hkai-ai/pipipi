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
import { characters, imageUrl } from "./catalog.js";
import { comicImagePrompt } from "./comic-prompt.js";
import {
    type EmojiDiagnostic,
    type EmojiObservation,
    type EmojiObservationRecord,
    emojiDiagnostic,
} from "./diagnostics.js";
import { imagePrompt } from "./prompt.js";
import { sceneComicPlanSchema, scenePlanSchema } from "./scene.js";
import { sceneComicImagePrompt, sceneImagePrompt } from "./scene-prompt.js";
import {
    briefSchema,
    comicBriefSchema,
    comicCanvas,
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
    planTokens: 8192,
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
    ),
): ProcessRegistration {
    if (!options.agent || !options.capability)
        throw new Error("表情包 Process 依赖未配置");
    return defineProcessRegistration({
        id: "character-emoji",
        version: options.version ?? "v1",
        timeoutMs: 480_000,
        inputSchema,
        outputSchema:
            options.version === "v2" ? sceneOutputSchema : outputSchema,
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
                    const brief = comicBriefSchema.parse(input);
                    const compiled = await context.runActivity(
                        "character_emoji_planning",
                        async () => {
                            if (options.version === "v2") {
                                const plan = sceneComicPlanSchema.parse(
                                    await options.agent.planSceneComic(
                                        brief,
                                        context.signal,
                                        characterEmojiBudget,
                                        observe,
                                    ),
                                );
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
                    size = comicCanvas(compiled.plan).size;
                } else {
                    const brief = briefSchema.parse(input);
                    const compiled = await context.runActivity(
                        "character_emoji_planning",
                        async () => {
                            if (options.version === "v2") {
                                const plan = scenePlanSchema.parse(
                                    await options.agent.planScene(
                                        brief,
                                        context.signal,
                                        characterEmojiBudget,
                                        observe,
                                    ),
                                );
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
            const brief = input;
            const imageUrls = brief.cast.map((member) =>
                imageUrl(member.character, member.appearance),
            );
            try {
                const image = characterEmojiImageSchema.parse(
                    await context.runActivity("character_emoji_rendering", () =>
                        options.capability.render(
                            { prompt, imageUrls, size },
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
