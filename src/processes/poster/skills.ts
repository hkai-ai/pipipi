import type { SkillRef } from "../../agent-runtime/skills.js";

export const posterSkillName = "minimal-zine-poster-prompt";

export function createPosterSkillRefs(options?: {
    path?: string;
}): readonly SkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: posterSkillName,
            path: options?.path ?? ".pi/skills/minimal-zine-poster-prompt",
        }),
    ]);
}
