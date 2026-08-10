import type { SkillRef } from "../../agent-runtime/skills.js";

export const crtSkillName = "tait-crt-interface-prompt";

export function createCrtSkillRefs(options?: {
    path?: string;
}): readonly SkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: crtSkillName,
            path: options?.path ?? ".pi/skills/tait-crt-interface-prompt",
        }),
    ]);
}
