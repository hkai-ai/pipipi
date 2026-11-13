/** 核验 Memebuy 来源摘要并生成拆解合同、纯检查器与完整无 Tool 规则快照。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const source = process.argv[2];
if (!source) throw new Error("请提供 Memebuy 应用目录");
const directory = ".pi/skills/print-design-template-compiler";
const manifest = JSON.parse(readFileSync(`${directory}/source-manifest.json`, "utf8")) as {files: {path: string; sha256: string}[]};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const contents = new Map<string, string>();
for (const file of manifest.files) {
    const bytes = readFileSync(resolve(source, file.path));
    if (hash(bytes) !== file.sha256) throw new Error(`来源变化，请先审查：${file.path}`);
    contents.set(file.path, bytes.toString("utf8"));
}
const generated: Record<string, string> = {};
const schema = JSON.parse(contents.get("docs/gallery/template-import/schema.json") ?? "");
schema.$id = "urn:pipipi:template-from-image:v3:runtime-v4";
schema.$defs.runtimeSemantics = {$ref: "#/$defs/runtimeSemanticsV4"};
generated[`${directory}/gallery.schema.json`] = `${JSON.stringify(schema, null, 2)}\n`;
for (const [path, content] of contents) {
    if (!path.endsWith(".ts")) continue;
    const name = path.split("/").at(-1);
    generated[`src/processes/template-from-image/design-spec/vendor/${name}`] = '/** 从固定 Memebuy 来源生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */\n' + content
        .replaceAll("'zod'", '"zod"')
        .replaceAll("(a[i] as string).codePointAt(0)!", "((a[i] as string).codePointAt(0) ?? 0)")
        .replaceAll("(b[i] as string).codePointAt(0)!", "((b[i] as string).codePointAt(0) ?? 0)")
        .replaceAll("'@/modules/gallery/templates/design-spec-schema'", '"./design-spec-schema.js"')
        .replace(/from '\.\/([^']+)'/gu, 'from "./$1.js"');
}
const preamble = `---
name: print-design-template-compiler
description: 从批准图片拆解印花结构与输入绑定，输出 Gallery 运行语义 v4 候选并独立复核。
---

# 已批准图片转印花模板

以下嵌入完整方法正本与作者合同。当前任务只产候选，不生成图片、不修改已批准图片、不入库、不发布。
无 Tool 环境：不执行文档内脚本、文件、网络、后台、导入或生成操作；像素测量仅使用宿主本次提供的证据，未测量的统计不得编造。
流程版本 v3 与运行语义 v4 分别管理。只输出 inputSchema.version=2 与 runtimeSemantics.version=4；没有 visualContract、promptEnhancement 或 preprocessSteps。本文后半的 v1～v3 示例仅为版本兼容背景，不能用于本次输出。
先看真实附件，记录整体、文字、颜色、层次和印花风险，再编写 designSpec。默认 same_design；输入绑定只开放当前引擎能消费的主体照片（全模板最多一个且 maxCount=1）及文本、配色。其他元素只开放文字；不创建内容图片或 reference_only 输入。
将原物与外形词留在 instance/originalObject/shapeFeatures 作为证据，defaults 写可执行的作者默认迁移；不得为通过检查伪造原始观察，执行描述不得混入原物外形。可替换默认答案不写入 technique、purpose、layout.role 或固定关系。描述可用 @元素id 与 {色:角色名} 引用。版面框为候选，必须人审叠图核对。
每个文字元素都有 defaults.texts，随主体的名字/释义标 followsSubject；固定口号保持默认字。配色角色有默认颜色。所有开放槽的文字默认值必须与绑定目标的 defaults 一致；主体可以 text+image，文字与配色只用 text。promptTemplate 由服务端从 defaults 单向生成，模型不得维护第二份提示词。
印花形态按已批准图片选一个：完整图形 standalone；场景/海报 rect_patch 且要有真实设计边框的 edge 元素；切开主体 bleed_crop。不能凭空声称审批图已有边框或已适合印刷；有缺陷如实标 needs_prep/not_for_apparel 并在观察中说明，运营可退回图片步骤重做。表达机制是推断，保留给人工确认。
首次输出 {observation,draft}，draft 只包含 key/title/description/inputSchema/runtimeSemantics/metadata(tags)。独立复核重新看同一批准图，只修有依据的字段并给出检查报告，不增加图片生成或自动采用。

`;
generated[`${directory}/SKILL.md`] = preamble + ["docs/gallery/print-design-preparation.md", "docs/gallery/agent-template-json-runtime-contract.md"].map(path => `\n<!-- source: ${path} -->\n\n${contents.get(path)}`).join("\n");
const check = process.argv.includes("--check");
for (const [path, raw] of Object.entries(generated)) {
    const content = path.endsWith(".ts") ? execFileSync("node_modules/.bin/biome", ["check", "--write", "--stdin-file-path", path], {input: raw, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]}) : raw;
    if (check) { if (readFileSync(path, "utf8") !== content) throw new Error(`需要重建：${path}`); }
    else writeFileSync(path, content);
}
console.log(JSON.stringify({check, files: Object.keys(generated), skillSha256: hash(generated[`${directory}/SKILL.md`] ?? ""), schemaSha256: hash(generated[`${directory}/gallery.schema.json`] ?? "")}));
