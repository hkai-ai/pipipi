/** 声明商品做同款方法 Runtime Skill 的固定版本与摘要。 */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export function createProductRemixSkillRefs(): readonly InstalledSkillRef[] {
    return [
        {
            name: "product-remix-method",
            version: "v1",
            sha256: "b579251f81b7b4fbbb84b6c4ecf759b655353dca0e74e57320cc6b42d9b7f74f",
            path: ".pi/skills/product-remix-method",
        },
    ];
}
