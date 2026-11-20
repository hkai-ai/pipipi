/** 从随应用发布的团队版本清单构造精确的本地 Skill 绑定。 */
import lock from "./skill-lock.json" with { type: "json" };
import type { InstalledSkillRef } from "./skills.js";

export function lockedSkill(
    name: string,
    path = `.pi/skills/${name}`,
): InstalledSkillRef {
    if (!Object.hasOwn(lock.skills, name))
        throw new Error(`缺少 Runtime Skill 绑定：${name}`);
    const { version, sha256 } = lock.skills[name as keyof typeof lock.skills];
    return Object.freeze({ name, version, sha256, path });
}
