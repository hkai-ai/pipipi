/** minimal-zine-poster/v1 绑定的准确 Runtime Skill */
import { lockedSkill } from "../../agent-runtime/locked-skill.js";
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const posterSkillName = "minimal-zine-poster-prompt";
export const posterSkillVersion = lockedSkill(posterSkillName).version;

export function createPosterSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([lockedSkill(posterSkillName, options?.path)]);
}
