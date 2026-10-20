/** 表情包编译 Agent 的窄接口。 */
import type { EmojiObservation } from "./diagnostics.js";
import type { SceneComicPlan, ScenePlan } from "./scene.js";
import type { Brief, ComicBrief, ComicPlan, EmojiPlan } from "./schema.js";

export type CharacterEmojiBudget = Readonly<{
    timeoutMs: number;
    searchTimeoutMs: number;
    maxSearchCalls: number;
    maxKeywords: number;
    maxModelCalls: number;
    searchTokens: number;
    planTokens: number;
    reasoningEffort: "none" | "low";
}>;

export type SceneEmojiAgent = Readonly<{
    planScene: (
        brief: Brief,
        signal: AbortSignal,
        budget: CharacterEmojiBudget,
        observe?: (record: EmojiObservation) => void,
    ) => Promise<ScenePlan>;
    planSceneComic: (
        brief: ComicBrief,
        signal: AbortSignal,
        budget: CharacterEmojiBudget,
        observe?: (record: EmojiObservation) => void,
    ) => Promise<SceneComicPlan>;
}>;

export type CharacterEmojiAgent = Readonly<{
    plan: (
        brief: Brief,
        signal: AbortSignal,
        budget: CharacterEmojiBudget,
        observe?: (record: EmojiObservation) => void,
    ) => Promise<EmojiPlan>;
    planComic: (
        brief: ComicBrief,
        signal: AbortSignal,
        budget: CharacterEmojiBudget,
        observe?: (record: EmojiObservation) => void,
    ) => Promise<ComicPlan>;
}>;
