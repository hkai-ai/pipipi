import type { SkillRef } from "../../agent-runtime/skills.js";

export const contentToolName = "process_business_content";

export function createContentSkillRefs(options?: {
    optimizationPath?: string;
}): readonly SkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: "content-optimization",
            path:
                options?.optimizationPath ?? ".pi/skills/content-optimization",
        }),
        Object.freeze({
            name: "content-integrity",
            path: ".pi/skills/content-integrity",
        }),
    ]);
}
