/** 固定模板编译 Runtime Skill 与 Gallery 合同的身份和字节摘要。 */
import { lockedSkill } from "../../agent-runtime/locked-skill.js";
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const templateSchemaSha256 =
    "38166c6b4939b11a1a5934fc1342baf35dba833dcda40a6179e5cde858369efb";
export const templateSchemaUrl = new URL(
    "../../../.pi/skills/meme-template-json-compiler/gallery.schema.json",
    import.meta.url,
);

export const templateV3SchemaSha256 =
    "d95721ad11f0a65c21b50a9203c7d370a57151cf217ad0a73267e903d88f2a68";
export const templateV3SchemaUrl = new URL(
    "../../../.pi/skills/meme-template-json-compiler/gallery-v3.schema.json",
    import.meta.url,
);

export function createTemplateSkillRefs(): readonly InstalledSkillRef[] {
    return Object.freeze([
        Object.freeze(lockedSkill("meme-template-json-compiler")),
    ]);
}
