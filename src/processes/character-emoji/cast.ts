/** 定义 v3 的双版本登场身份及分镜对白归属，不改变 v2 合同。 */
import { z } from "zod";
import { imageOptionsShape } from "./image-options.js";
import {
    briefSchema,
    type CreationBrief,
    castMemberSchema,
    comicBriefSchema,
    MAX_CAST,
} from "./schema.js";

export const castId = (member: { character: string; appearance: string }) =>
    `${member.character}:${member.appearance}`;
const cast = z
    .array(castMemberSchema)
    .min(1)
    .max(MAX_CAST)
    .refine(
        (members) => new Set(members.map(castId)).size === members.length,
        "同一角色的同一版本只能登场一次",
    );
export const versionedBriefSchema = briefSchema.extend({
    cast,
    ...imageOptionsShape,
});
export const versionedComicBriefSchema = comicBriefSchema.extend({
    cast,
    ...imageOptionsShape,
});
export const versionedInputSchema = z.union([
    versionedBriefSchema,
    versionedComicBriefSchema,
]);
export const CAST_IDENTITY_RULE =
    "演员以character与appearance共同区分。同一模型的两个版本是独立登场者，不能合并。actors逐人填写appearance；对白speaker填写character:appearance（如Claude:Girl），且属于本格演员。scene按模型名和版本明确每个人的动作，跨格保持身份。参考图顺序与cast一致。";

export function matchesVersionedCast(
    brief: CreationBrief,
    panels: readonly {
        actors: readonly { character: string; appearance?: string }[];
        texts?: readonly { speaker: string | null }[];
    }[],
) {
    const expected = new Set(brief.cast.map(castId));
    const seen = new Set<string>();
    for (const panel of panels) {
        const ids = panel.actors.map(
            (actor) => `${actor.character}:${actor.appearance}`,
        );
        if (
            new Set(ids).size !== ids.length ||
            ids.some((id) => !expected.has(id))
        )
            return false;
        if (
            panel.texts?.some(
                (text) => text.speaker !== null && !ids.includes(text.speaker),
            )
        )
            return false;
        for (const id of ids) seen.add(id);
    }
    return seen.size === expected.size;
}
