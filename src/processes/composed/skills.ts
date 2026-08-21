/** composed-task/v1 绑定的准确 Planner Runtime Skill */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const composedPlannerSkillName = "composed-task-planner";
export const composedPlannerSkillVersion = "v1";

export function createComposedSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: composedPlannerSkillName,
            version: composedPlannerSkillVersion,
            sha256: "0f64ffbce67f6c75176234c9d59beaf126d55a6124e360282b898f05427d6103",
            path: options?.path ?? ".pi/skills/composed-task-planner",
        }),
    ]);
}
