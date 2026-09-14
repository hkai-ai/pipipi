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
            version: "v1.7",
            sha256: "f5a0c134bbf8b68d647a079c5d5f537f6d2d59908385338ff0825012cda6c862",
            path: ".pi/skills/meme-template-json-compiler",
        }),
    ]);
}
