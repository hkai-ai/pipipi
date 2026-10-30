/** 编译单图构思输入、固定业务规则及公开方案的图片提示词。 */

import { imageTextRule, textPolicy } from "./caption-policy.js";
import { appearanceLabels, characterName } from "./catalog.js";
import { characterPersonas } from "./character-personas.js";
import type { Brief, Composition } from "./schema.js";
import { sceneFromPlan } from "./schema.js";

export const EMOJI_PROMPT_VERSION = "ai-character-emoji/v25";

export const PLANNER_SYSTEM_PROMPT = `设计一张方形表情包，默认白底动漫贴纸；用户要求或情节需要时可调整风格与背景，在composition中说明。截取一个主笑点的可见瞬间，不分格。actors包含cast的全部角色且不重复，按角色身份绑定表演，排列顺序不限；围绕同一反差互动，让动作与关键证据清楚。
主台词遵守本次配字要求，最多28字。propMarks仅用于辨认情节目标品牌，不重复身份标识，不充当解释笑点的标签；公司名与产品名不混用。`;

export function captionRule(brief: Brief): string {
    const { noText, noDialogue, setting } = textPolicy(brief);
    if (noText)
        return "用户明确禁止任何文字，优先于配字设置：caption为空、identityMark为null、propMarks为空；场景也不出现文字或数字。";
    if (noDialogue)
        return "用户明确不要台词：caption为空，不留主台词空位；可保留场景需要的标识与辅助文字。";
    switch (setting?.mode) {
        case "auto":
            return "自动配一句自然、简短的非空主台词，不沿用idea中指定的台词。";
        case "custom":
            return "captionSetting.text原样作为唯一主台词。";
        default:
            return "从idea理解配字意图：明确指定的台词原样保留，后续修正优先，场景引号不自动视为台词；不要主台词则caption为空，禁止任何文字则同时清空标识与场景文字。未指定时自动配一句自然、简短的主台词。";
    }
}

export function plannerInput(brief: Brief) {
    return JSON.stringify({
        cast: brief.cast.map((member, index) => ({
            ...member,
            referenceNumber: index + 1,
            identityLabel: characterName(member.character),
            creativeBrief: characterPersonas[member.character],
        })),
        idea: brief.idea,
        captionRule: captionRule(brief),
        ...(brief.captionSetting
            ? { captionSetting: brief.captionSetting }
            : {}),
    });
}

export function imagePrompt({ brief, plan, caption, scene }: Composition) {
    // 自动场景已包含逐人动作和关键条件，拆开输出避免重复；手动改写的场景保留原文。
    const composition =
        scene === sceneFromPlan(plan) ? plan.composition : scene;
    return [
        `根据${brief.cast.length}张角色参考图重新绘制一张表情包，恰好${brief.cast.length}位角色共同登场。参考图仅提供身份，不照搬姿势、构图或原图文字。单张方形，不分格；风格与背景遵循方案，未指定时采用白底动漫贴纸。`,
        "外观优先级：方案中明确要求的伪装、染发或换装优先于参考图，只改变指定部分；未要求改变的特征沿用对应参考图。穿戴状态按方案实际呈现，不得改成手持或旁置的道具。",
        ...brief.cast.map((member, index) => {
            const actor = plan.actors.find(
                (actor) => actor.character === member.character,
            );
            if (!actor) throw new Error("方案缺少所选角色");
            const mark = actor.identityMark;
            return [
                `参考图${index + 1}只对应${member.character}（${appearanceLabels[member.appearance]}），是该角色默认外观的唯一基准，不与其他角色交换或混合。`,
                `${member.character}的表演：${actor.position}；${actor.expression}；${actor.action}。`,
                mark
                    ? `${member.character}仅允许一处身份标识${JSON.stringify(mark.text)}，附着于${mark.carrier}，位置${mark.placement}；无法自然容纳则省略。`
                    : `${member.character}不添加文字身份标识。`,
            ].join("\n");
        }),
        ...(plan.propMarks ?? []).map(
            (mark) =>
                `情节道具品牌标识${JSON.stringify(mark.text)}，仅附着于${mark.carrier}，位置${mark.placement}；属于动作对象，不是新增角色或主角身份，不重绘对应品牌角色。`,
        ),
        `创作意图（不要画成文字）：${plan.joke}`,
        `最终画面要求：${composition}`,
        `必须呈现的画面条件：${plan.punchlineDetail}\n人物动作、道具接触位置和视线必须体现上述关系，不能只摆齐道具。`,
        caption
            ? `唯一主台词：${JSON.stringify(caption)}。准确绘制，字大清晰，不遮脸和关键证据。`
            : "无主台词，不留台词空位。",
        imageTextRule(brief),
        "不要增加名单外角色、格子或多张候选。各角色的肢体、道具、视线和互动关系清楚，缩成聊天表情仍能看懂。",
    ].join("\n");
}
