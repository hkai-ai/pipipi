/** 由母版方法文案生成 Runtime Skill 快照与精确版本绑定；--check 核验快照与绑定一致。 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
    FORM_RULES,
    HEAVY_METHOD,
    MEDIUM_METHOD,
    RETRY_RULE,
    VERIFIER_RULES,
} from "../src/processes/template-master/method.js";
import { createTemplateMasterSkillRefs } from "../src/processes/template-master/skills.js";

const name = "template-master-method";
const version = "v1";
const path = `.pi/skills/${name}`;
const body = [
    "本 Skill 保存母版（印花版）生成与校验的方法。运行时由服务端把 designSpec 的逐字文字、配色、版面框与原图标记确定性拼进下列指令；不执行脚本、不联网、不调用 Tool。",
    MEDIUM_METHOD,
    HEAVY_METHOD,
    `# 输出形态\n${Object.entries(FORM_RULES).map(([k, v]) => `- ${k}：${v}`).join("\n")}`,
    `# 重试\n${RETRY_RULE}`,
    VERIFIER_RULES,
].join("\n\n");
const content = `---\nname: ${name}\ndescription: 母版中档修复、重档重绘与对照校验的方法。\n---\n\n${body}\n`;
const provenance = `# 来源与适配\n\n由 tools/build-template-master-skill.ts 从 src/processes/template-master/method.ts 完整生成；方法文案由本仓库维护，无第三方来源。校验阈值见 src/processes/template-master/thresholds.ts。规则没有脚本或网络权限；Tool 与模型由服务端固定。\n`;
const sha256 = createHash("sha256").update(content).digest("hex");
const check = process.argv.includes("--check");
if (check) {
    if (readFileSync(`${path}/SKILL.md`, "utf8") !== content || readFileSync(`${path}/SOURCE.md`, "utf8") !== provenance)
        throw new Error("母版 Skill 快照已过期");
    const [ref] = createTemplateMasterSkillRefs();
    if (ref?.sha256 !== sha256 || ref.version !== version) throw new Error("母版 Skill 绑定已过期");
} else {
    mkdirSync(path, { recursive: true });
    writeFileSync(`${path}/SKILL.md`, content);
    writeFileSync(`${path}/SOURCE.md`, provenance);
    writeFileSync(
        "src/processes/template-master/skills.ts",
        `/** 声明母版方法 Runtime Skill 的固定版本与摘要。 */\nimport type { InstalledSkillRef } from "../../agent-runtime/skills.js";\n\nexport function createTemplateMasterSkillRefs(): readonly InstalledSkillRef[] {\n    return [\n        {\n            name: "${name}",\n            version: "${version}",\n            sha256: "${sha256}",\n            path: "${path}",\n        },\n    ];\n}\n`,
    );
}
console.log(JSON.stringify({ check, name, version, sha256 }));
