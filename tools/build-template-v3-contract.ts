/** 从固定旧合同与已审查的 Memebuy 作者合同生成 v3 快照，旧 Skill 正文保持完整。 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { templateSchemaSha256, templateSchemaUrl, templateV3SchemaSha256, templateV3SchemaUrl } from "../src/processes/template-from-image/skills.js";

const source = process.argv[2];
if (!source) throw new Error("请提供 Memebuy docs/gallery/template-import/schema.json");
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const oldBytes = readFileSync(templateSchemaUrl);
if (hash(oldBytes) !== templateSchemaSha256) throw new Error("旧合同摘要不匹配");
const sourceBytes = readFileSync(source);
const sourceSha256 = "929b539fbd05918bcdd17ea6ab719ccd4d84fc3f31e7f02f42d08436f63e77b5";
if (hash(sourceBytes) !== sourceSha256) throw new Error("Memebuy 作者合同已变化，请先审查变更");
const legacy = JSON.parse(oldBytes.toString("utf8"));
const upstream = JSON.parse(sourceBytes.toString("utf8"));
for (const [name, definition] of Object.entries(upstream.$defs)) {
    if (name.endsWith("V3")) legacy.$defs[name] = definition;
}
legacy.$defs.runtimeSemanticsV3.properties.inputBindings = legacy.$defs.runtimeSemanticsV2.properties.inputBindings;
legacy.$defs.runtimeVisualContractV3.required.push("colorAndLight");
legacy.$defs.runtimeSemantics = {$ref: "#/$defs/runtimeSemanticsV3"};
legacy.$id = "urn:pipipi:template-from-image:v2:runtime-v3";
const content = `${JSON.stringify(legacy, null, 2)}\n`;
if (hash(content) !== templateV3SchemaSha256) throw new Error("生成合同摘要不匹配，请审查输出并同步固定摘要");
if (process.argv.includes("--check")) {
    if (!readFileSync(templateV3SchemaUrl).equals(Buffer.from(content))) throw new Error("v3 合同需要重新生成");
} else writeFileSync(templateV3SchemaUrl, content);
console.log(JSON.stringify({sourceSha256, sha256: hash(content)}));
