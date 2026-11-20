/** 声明母版方法 Runtime Skill 的固定版本与摘要。 */
import { lockedSkill } from "../../agent-runtime/locked-skill.js";
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export function createTemplateMasterSkillRefs(): readonly InstalledSkillRef[] {
    return [lockedSkill("template-master-method")];
}
