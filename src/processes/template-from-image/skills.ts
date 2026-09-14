/** 固定模板编译 Runtime Skill 与 Gallery 合同的身份和字节摘要。 */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const templateSchemaSha256 =
    "38166c6b4939b11a1a5934fc1342baf35dba833dcda40a6179e5cde858369efb";
export const templateSchemaUrl = new URL(
    "../../../.pi/skills/meme-template-json-compiler/gallery.schema.json",
    import.meta.url,
);

export function createTemplateSkillRefs(): readonly InstalledSkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: "meme-template-json-compiler",
            version: "v1.6",
            sha256: "1ddaad7a8075f14d5c9e6a0303ae0d506ac7d4789f0858501b00cb370fdcea46",
            path: ".pi/skills/meme-template-json-compiler",
        }),
    ]);
}
