/** 三个新闻图片风格各自绑定的准确 Runtime Skill */
import { lockedSkill } from "../../agent-runtime/locked-skill.js";
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const paleWatercolorSkillName = "news-image-pale-watercolor-prompt";
export const rawHumanismSkillName = "news-image-raw-humanism-prompt";
export const narrativeMonumentSkillName =
    "news-image-narrative-monument-prompt";

export function createPaleWatercolorSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([lockedSkill(paleWatercolorSkillName, options?.path)]);
}

export function createRawHumanismSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([lockedSkill(rawHumanismSkillName, options?.path)]);
}

export function createNarrativeMonumentSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([
        lockedSkill(narrativeMonumentSkillName, options?.path),
    ]);
}
