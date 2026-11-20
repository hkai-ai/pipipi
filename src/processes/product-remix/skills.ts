/** 声明商品做同款方法 Runtime Skill 的固定版本与摘要。 */
import { lockedSkill } from "../../agent-runtime/locked-skill.js";
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export function createProductRemixSkillRefs(): readonly InstalledSkillRef[] {
    return [lockedSkill("product-remix-method")];
}
