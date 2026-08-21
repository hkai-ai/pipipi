/** crt-interface-image/v1 绑定的准确 Runtime Skill */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const crtSkillName = "tait-crt-interface-prompt";
export const crtSkillVersion = "v1";

export function createCrtSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: crtSkillName,
            version: crtSkillVersion,
            sha256: "6565e143c5bc5bc67909387fd00689748aaa2640c907ff85f6731885f2927910",
            path: options?.path ?? ".pi/skills/tait-crt-interface-prompt",
        }),
    ]);
}
