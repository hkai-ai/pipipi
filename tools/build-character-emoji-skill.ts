/** 生成表情包公共及模式 Skill 快照，并校验绑定版本与摘要。 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SCENE_PLANNER_RULES, SCENE_SINGLE_RULES, SCENE_COMIC_RULES } from "../src/processes/character-emoji/scene-prompt.js";

import { createCharacterEmojiSkillRefs, characterEmojiSkillHash } from "../src/processes/character-emoji/skills.js";

const sources = [
    { name: "character-emoji-planner", version: "v18", description: "角色表情包的本地素材、按需搜索、创作和内部输出规则。", body: SCENE_PLANNER_RULES, source: "scene-prompt.ts（character-emoji/v2）" },
    { name: "character-emoji-single", version: "v4", description: "角色表情包的单图构思规则。", body: SCENE_SINGLE_RULES, source: "scene-prompt.ts（character-emoji/v2）" },
    { name: "character-emoji-comic", version: "v6", description: "角色表情包的单页漫画构思规则。", body: SCENE_COMIC_RULES, source: "scene-prompt.ts（character-emoji/v2）" },
];
const refs = sources.map(({ name, version, description, body, source }) => {
    const path = `.pi/skills/${name}`;
    const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`.replace(/\r\n/g, "\n");
    const provenance = `# 来源与适配\n\n由 tools/build-character-emoji-skill.ts 从 ${source} 完整生成；与公共或对应模式规则一起加载。基于已移植的 Memebuy 业务合同精简，不宣称与 Memebuy 当前提示词逐字一致。规则没有脚本或网络权限；Tool 与模型由服务端固定。素材授权见 docs/processes/common/character-emoji/README.md。\n`;
    if (process.argv.includes("--check")) {
        if (readFileSync(`${path}/SKILL.md`, "utf8") !== content || readFileSync(`${path}/SOURCE.md`, "utf8") !== provenance)
            throw new Error("表情包 Skill 快照已过期");
    } else {
        mkdirSync(path, { recursive: true });
        writeFileSync(`${path}/SKILL.md`, content);
        writeFileSync(`${path}/SOURCE.md`, provenance);
    }
    return { name, version, sha256: createHash("sha256").update(content).digest("hex"), path };
});
const binding = `/** 声明表情包公共及模式 Runtime Skill 的固定版本与摘要。 */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const characterEmojiSkillHash = "${refs[0].sha256}";
export function createCharacterEmojiSkillRefs(): readonly InstalledSkillRef[] {
    return ${JSON.stringify(refs, null, 4)};
}
`;
const bindingPath = "src/processes/character-emoji/skills.ts";
if (process.argv.includes("--check")) {
    if (JSON.stringify(createCharacterEmojiSkillRefs()) !== JSON.stringify(refs) || characterEmojiSkillHash !== refs[0].sha256)
        throw new Error("表情包 Skill 绑定已过期");
} else writeFileSync(bindingPath, binding);
