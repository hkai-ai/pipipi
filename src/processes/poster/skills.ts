/** minimal-zine-poster/v1 绑定的准确 Runtime Skill */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

import lock from "./skill-lock.json" with { type: "json" };

export const posterSkillName = lock.name;
export const posterSkillVersion = lock.version;

export function createPosterSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: posterSkillName,
            version: posterSkillVersion,
            sha256: lock.sha256,
            path: options?.path ?? ".pi/skills/minimal-zine-poster-prompt",
        }),
    ]);
}
