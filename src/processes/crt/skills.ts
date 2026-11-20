/** crt-interface-image/v1 绑定的准确 Runtime Skill */
import { lockedSkill } from "../../agent-runtime/locked-skill.js";
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const crtSkillName = "tait-crt-interface-prompt";
export const crtSkillVersion = lockedSkill(crtSkillName).version;

export function createCrtSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([lockedSkill(crtSkillName, options?.path)]);
}
