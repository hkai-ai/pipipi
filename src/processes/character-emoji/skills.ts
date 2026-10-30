/** 声明表情包公共及模式 Runtime Skill 的固定版本与摘要。 */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const characterEmojiSkillHash =
    "d083e253c6c63df90fea561ab20dc018fe7ee0759caeba99f0fe9d0637acf0d9";
export function createCharacterEmojiSkillRefs(): readonly InstalledSkillRef[] {
    return [
        {
            name: "character-emoji-planner",
            version: "v18",
            sha256: "d083e253c6c63df90fea561ab20dc018fe7ee0759caeba99f0fe9d0637acf0d9",
            path: ".pi/skills/character-emoji-planner",
        },
        {
            name: "character-emoji-single",
            version: "v4",
            sha256: "5310966ba4c7f772bcad21f3ddf285cf813e592074596a564b017c3160f6f6dc",
            path: ".pi/skills/character-emoji-single",
        },
        {
            name: "character-emoji-comic",
            version: "v6",
            sha256: "8e04fb034a099735735ca704fa2b5437b3538934d6671ef212b81201bb6b51bf",
            path: ".pi/skills/character-emoji-comic",
        },
    ];
}
