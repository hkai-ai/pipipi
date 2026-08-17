import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const contentToolName = "process_business_content";
export const contentOptimizationSkillVersion = "v1";
export const contentIntegritySkillVersion = "v1";

export function createContentSkillRefs(options?: {
    optimizationPath?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: "content-optimization",
            version: contentOptimizationSkillVersion,
            sha256: "ac6544f37f24550b4e3be8e89b5ab2658eff1892087ff2f5849cdc400143fb2f",
            path:
                options?.optimizationPath ?? ".pi/skills/content-optimization",
        }),
        Object.freeze({
            name: "content-integrity",
            version: contentIntegritySkillVersion,
            sha256: "d94db928f34693a3b9705bbfd2c8a1ee80c9b3ee601f4ba957ea3e87d410000e",
            path: ".pi/skills/content-integrity",
        }),
    ]);
}
