/** composed-task/v1 绑定的准确 Planner Runtime Skill */
import { lockedSkill } from "../../agent-runtime/locked-skill.js";
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const composedPlannerSkillName = "composed-task-planner";
export const composedPlannerSkillVersion = lockedSkill(
    composedPlannerSkillName,
).version;

export function createComposedSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([
        lockedSkill(composedPlannerSkillName, options?.path),
    ]);
}
