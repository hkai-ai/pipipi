/** 固定照片风格 Runtime Skill 的本地路径与内容摘要。 */
import { lockedSkill } from "../../agent-runtime/locked-skill.js";
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";
import { type PhotoPosterStyle, photoPosterProcessId } from "./style.js";

export function createPhotoPosterSkillRefs(
    style: PhotoPosterStyle,
): readonly InstalledSkillRef[] {
    const name = `${photoPosterProcessId(style)}-prompt`;
    return Object.freeze([lockedSkill(name)]);
}
