/** 声明表情包公共及模式 Runtime Skill 的固定版本与摘要。 */
import { lockedSkill } from "../../agent-runtime/locked-skill.js";
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const characterEmojiSkillHash = lockedSkill(
    "character-emoji-planner",
).sha256;
export function createCharacterEmojiSkillRefs(): readonly InstalledSkillRef[] {
    return [
        lockedSkill("character-emoji-planner"),
        lockedSkill("character-emoji-single"),
        lockedSkill("character-emoji-comic"),
    ];
}
