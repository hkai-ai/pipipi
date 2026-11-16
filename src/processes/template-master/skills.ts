/** 声明母版方法 Runtime Skill 的固定版本与摘要。 */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export function createTemplateMasterSkillRefs(): readonly InstalledSkillRef[] {
    return [
        {
            name: "template-master-method",
            version: "v1",
            sha256: "0520914d0926e5341ac2832ef0102a8ac9737d1f09c5d5786f0e2f2ed98b8198",
            path: ".pi/skills/template-master-method",
        },
    ];
}
