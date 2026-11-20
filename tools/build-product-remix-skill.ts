/** 由商品做同款方法文案生成 Runtime Skill 快照与精确版本绑定；--check 核验快照与绑定一致。 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
    PLANNER_RULES,
    PRINT_ARTWORK_RULES,
    RETRY_RULE,
    TIER_RULES,
    VERIFIER_RULES,
} from "../src/processes/product-remix/method.js";
import { createProductRemixSkillRefs } from "../src/processes/product-remix/skills.js";

const name = "product-remix-method";
const version = "v1";
const path = `.pi/skills/${name}`;
const body = [
    "本 Skill 保存商品做同款（product-remix/v1）的单层视觉基准规划、平面印花硬性守则、多档改图指令编译与视觉质检方法；不执行脚本、不联网、不调用 Tool。",
    PLANNER_RULES,
    `# 复杂度档位策略\n${Object.entries(TIER_RULES)
        .map(([tier, rule]) => `- ${tier}：${rule}`)
        .join("\n")}`,
    `# 印花硬性守则\n${PRINT_ARTWORK_RULES}`,
    `# 质检重试\n${RETRY_RULE}`,
    VERIFIER_RULES,
].join("\n\n");
const content = `---\nname: ${name}\ndescription: 商品做同款的分档规划、印花守则与视觉质检方法。\n---\n\n${body}\n`;
const provenance = `# 来源与适配\n\n由 tools/build-product-remix-skill.ts 从 src/processes/product-remix/method.ts 完整生成；方法文案由本仓库维护，无第三方来源。规则没有脚本或网络权限；Tool 与模型由服务端固定。\n`;
const sha256 = createHash("sha256").update(content).digest("hex");
const check = process.argv.includes("--check");
if (check) {
    if (
        readFileSync(`${path}/SKILL.md`, "utf8") !== content ||
        readFileSync(`${path}/SOURCE.md`, "utf8") !== provenance
    ) {
        throw new Error("商品做同款 Skill 快照已过期");
    }
    const [ref] = createProductRemixSkillRefs();
    if (ref?.sha256 !== sha256 || ref.version !== version) {
        throw new Error("商品做同款 Skill 绑定已过期");
    }
} else {
    mkdirSync(path, { recursive: true });
    writeFileSync(`${path}/SKILL.md`, content);
    writeFileSync(`${path}/SOURCE.md`, provenance);
    writeFileSync(
        "src/processes/product-remix/skills.ts",
        `/** 声明商品做同款方法 Runtime Skill 的固定版本与摘要。 */\nimport type { InstalledSkillRef } from "../../agent-runtime/skills.js";\n\nexport function createProductRemixSkillRefs(): readonly InstalledSkillRef[] {\n    return [\n        {\n            name: "${name}",\n            version: "${version}",\n            sha256: "${sha256}",\n            path: "${path}",\n        },\n    ];\n}\n`,
    );
}
console.log(JSON.stringify({ check, name, version, sha256 }));
