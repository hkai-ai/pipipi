import type { SkillRef } from "../../agent-runtime/skills.js";

export const paleWatercolorSkillName = "news-image-pale-watercolor-prompt";
export const rawHumanismSkillName = "news-image-raw-humanism-prompt";
export const narrativeMonumentSkillName =
    "news-image-narrative-monument-prompt";

export function createPaleWatercolorSkillRefs(options?: {
    path?: string;
}): readonly SkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: paleWatercolorSkillName,
            path:
                options?.path ?? ".pi/skills/news-image-pale-watercolor-prompt",
        }),
    ]);
}

export function createRawHumanismSkillRefs(options?: {
    path?: string;
}): readonly SkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: rawHumanismSkillName,
            path: options?.path ?? ".pi/skills/news-image-raw-humanism-prompt",
        }),
    ]);
}

export function createNarrativeMonumentSkillRefs(options?: {
    path?: string;
}): readonly SkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: narrativeMonumentSkillName,
            path:
                options?.path ??
                ".pi/skills/news-image-narrative-monument-prompt",
        }),
    ]);
}
