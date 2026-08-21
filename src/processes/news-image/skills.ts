/** 三个新闻图片风格各自绑定的准确 Runtime Skill */
import type { InstalledSkillRef } from "../../agent-runtime/skills.js";

export const paleWatercolorSkillName = "news-image-pale-watercolor-prompt";
export const rawHumanismSkillName = "news-image-raw-humanism-prompt";
export const narrativeMonumentSkillName =
    "news-image-narrative-monument-prompt";
export const newsImageSkillVersion = "v1";

export function createPaleWatercolorSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: paleWatercolorSkillName,
            version: newsImageSkillVersion,
            sha256: "2dc347c87a0ddbdcff9624637b9ae4d07013b2554117ddc3eec3ad4736304816",
            path:
                options?.path ?? ".pi/skills/news-image-pale-watercolor-prompt",
        }),
    ]);
}

export function createRawHumanismSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: rawHumanismSkillName,
            version: newsImageSkillVersion,
            sha256: "8b273f73a35dde38b6621ea832032b6d27d2045c2f93dadd9dfb8bd86d61c2dd",
            path: options?.path ?? ".pi/skills/news-image-raw-humanism-prompt",
        }),
    ]);
}

export function createNarrativeMonumentSkillRefs(options?: {
    path?: string;
}): readonly InstalledSkillRef[] {
    return Object.freeze([
        Object.freeze({
            name: narrativeMonumentSkillName,
            version: newsImageSkillVersion,
            sha256: "7875fdb725a4255ee971622bd75f4acb55af4030071bc2ae354ba3b611a1e0d1",
            path:
                options?.path ??
                ".pi/skills/news-image-narrative-monument-prompt",
        }),
    ]);
}
