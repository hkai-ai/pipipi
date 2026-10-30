/** 统一明确的无字、无对白要求及绘图时的辅助文字边界。 */
import type { Brief } from "./schema.js";

export function textRestrictions(idea: string) {
    return {
        noText: /(?:^|[，。；\n])\s*(?:不要文字|不要任何文字|禁止任何文字)\s*(?=$|[，。；！!\n])/.test(
            idea.trim(),
        ),
        noDialogue:
            /(?:^|[，。；\n])\s*(?:不要对白|不要台词)\s*(?=$|[，。；！!\n])/.test(
                idea.trim(),
            ),
    };
}

export function textPolicy(brief: Pick<Brief, "idea" | "captionSetting">) {
    const restrictions = textRestrictions(brief.idea);
    const explicit = brief.captionSetting;
    const setting = restrictions.noText
        ? { mode: "none" as const }
        : explicit?.mode === "custom" || explicit?.mode === "none"
          ? explicit
          : restrictions.noDialogue
            ? { mode: "none" as const }
            : explicit;
    return {
        noText: restrictions.noText,
        noDialogue: setting?.mode === "none",
        setting,
    };
}

export function imageTextRule(
    brief: Pick<Brief, "idea" | "captionSetting">,
): string {
    const { noText, noDialogue } = textPolicy(brief);
    if (noText)
        return "用户要求禁止任何文字：不绘制台词、标识、场景文字、数字或公式。";
    return [
        "方案指定的文字逐字准确。可根据场景补充少量必要的短字、数字或符号，不抢主台词、不遮挡关键动作，不增加解释笑点的长文或水印。",
        noDialogue
            ? "用户要求无对白，不绘制人物台词。"
            : "人物台词按方案绘制。",
    ].join(" ");
}
