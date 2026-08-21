/** minimal-zine-poster/v1 绑定的准确 Runtime Skill */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const posterSkillName = "minimal-zine-poster-prompt";
export const posterSkillVersion = "v1";

export function createPosterSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: posterSkillName,
            version: posterSkillVersion,
            sha256: "58aaaef1f0261ba68b47f3810f8357599f7e66298b11927bf9560df3f34f49eb",
            path: options?.path ?? ".pi/skills/minimal-zine-poster-prompt",
        }),
    ]);
}
