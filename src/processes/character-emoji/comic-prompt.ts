/** 组装漫画构思输入，并保留 v1 回放使用的规则与生图指令。 */

import { imageTextRule } from "./caption-policy.js";
import { appearanceLabels, characterName } from "./catalog.js";
import { characterPersonas } from "./character-personas.js";
import type { ComicBrief, ComicPlan, LegacyComicBrief } from "./schema.js";
import { legacyComicLayout } from "./schema.js";

export const COMIC_PROMPT_VERSION = "ai-character-comic/v15";
export const COMIC_PLANNER_SYSTEM_PROMPT = `设计有连续因果的单页漫画，用能完整表达反差的最少格数（2至6格）。结尾优先用可见后果或反应收住笑点，省去重复反应与事后讲解；用户指定结局优先。panels按阅读顺序排列，每项为一个独立瞬间；各格可只出现部分角色，整篇覆盖cast。
选择aspectRatio，布局由程序按画幅和格数生成：横向2至3格单行，其余2至3格单列，4至6格每行两列。不得设计子格或嵌格。
对白自然简短，用户指定台词逐字保留。允许无声格；不要对白时无dialogue，禁止任何文字时texts为空且identityMark为null，场景也不出现文字或数字。对白speaker必须在本格登场，旁白与标牌speaker为null；文字位置靠近对应人物且不遮挡关键动作。身份标识不重复放入texts。`;
export function comicPlannerInput(
    brief: ComicBrief,
    legacyBrief?: LegacyComicBrief,
) {
    return JSON.stringify({
        ...(legacyBrief
            ? {
                  legacyLayout: {
                      panelCount: 4,
                      layout: legacyComicLayout(legacyBrief).label,
                      aspectRatio:
                          legacyBrief.layout === "vertical-4" ? "1:2" : "1:1",
                  },
              }
            : {}),
        cast: brief.cast.map((member, index) => ({
            ...member,
            referenceNumber: index + 1,
            identityLabel: characterName(member.character),
            creativeBrief: characterPersonas[member.character],
        })),
        idea: brief.idea,
    });
}

export function comicImagePrompt(brief: ComicBrief, plan: ComicPlan) {
    return [
        `绘制一张完整动漫漫画，严格${plan.panels.length}格，整页宽高比${plan.page.aspectRatio}。格线明确，无额外封面或标题格。`,
        `整页排版：${plan.page.layout}`,
        `阅读顺序：${plan.page.readingOrder}`,
        "严格按各格frame绘制，人物与道具比例自然，关键动作与对白完整清楚。",
        ...brief.cast.map(
            (member, index) =>
                `参考图${index + 1}只对应${member.character}（${appearanceLabels[member.appearance]}），在所有分格保持同一身份与比例，不交换或混合外貌。参考图不提供构图、动作或文字。`,
        ),
        "用户明确的换装、染发、伪装只覆盖指定部分；其余外貌沿用对应参考图。每格只画该格列出的角色，不强制全员同框，不增加其他人物。",
        `创作意图（不可画成文字）：${plan.joke}`,
        `跨格连续性：${plan.continuity}`,
        ...plan.panels.map((panel) =>
            [
                `第${panel.index}格的位置与尺寸：${panel.frame}`,
                `格内构图：${panel.composition}`,
                ...panel.actors.map(
                    (actor) =>
                        `${actor.character}：${actor.position}；${actor.expression}；${actor.action}。${
                            actor.identityMark
                                ? `身份文字仅${JSON.stringify(actor.identityMark.text)}，附着于${actor.identityMark.carrier}，位置${actor.identityMark.placement}。`
                                : "不添加文字身份标识。"
                        }`,
                ),
                ...panel.texts.map(
                    (text) =>
                        `${text.kind === "dialogue" ? `${text.speaker}的对白` : text.kind === "narration" ? "旁白" : "场景文字"}：${JSON.stringify(text.text)}，位置${text.placement}。`,
                ),
                `必须呈现：${panel.punchlineDetail}`,
            ].join("\n"),
        ),
        imageTextRule(brief),
        "按方案分镜绘制，字迹清楚且不遮脸和关键道具；服装、场景和道具变化遵循连续性。仅输出一张整页漫画。",
    ].join("\n");
}
