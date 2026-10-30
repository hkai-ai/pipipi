import { describe, expect, it } from "vitest";
import { textRestrictions } from "../src/processes/character-emoji/caption-policy.js";
import { parsePlannerOutput } from "../src/processes/character-emoji/planner-output.js";
import {
    captionRule,
    imagePrompt,
} from "../src/processes/character-emoji/prompt.js";
import { sceneImagePrompt } from "../src/processes/character-emoji/scene-prompt.js";
import {
    type Brief,
    type EmojiPlan,
    sceneFromPlan,
} from "../src/processes/character-emoji/schema.js";

const brief: Brief = {
    cast: [{ character: "DeepSeek", appearance: "Chibi" }],
    idea: "深色机房，角色拿着写有404的小牌子",
    captionSetting: { mode: "auto" },
};
const plan: EmojiPlan = {
    caption: "我只改一行，你看呢",
    joke: "小修补引起大故障",
    actors: [
        {
            character: "DeepSeek",
            expression: "茫然",
            action: "举起小牌",
            position: "中央",
            identityMark: null,
        },
    ],
    propMarks: [],
    composition: "深色机房背景，牌上写404",
    punchlineDetail: "角色举着小牌，背后整面屏幕熄灭",
};
const renderPrompt = (input: Brief, value = plan) =>
    imagePrompt({
        brief: input,
        plan: value,
        caption: value.caption,
        scene: sceneFromPlan(value),
    });

it("角色错序仍按身份匹配参考图，重复或缺失角色仍拒绝", () => {
    const input: Brief = {
        ...brief,
        cast: [{ character: "Claude", appearance: "Chibi" }, ...brief.cast],
    };
    const value: EmojiPlan = {
        ...plan,
        actors: [
            plan.actors[0],
            { ...plan.actors[0], character: "Claude", action: "拉动绳子" },
        ],
    };
    expect(parsePlannerOutput(JSON.stringify(value), input).success).toBe(true);
    const prompt = renderPrompt(input, value);
    expect(prompt).toContain("Claude的表演：中央；茫然；拉动绳子");
    expect(prompt).toContain("DeepSeek的表演：中央；茫然；举起小牌");
    expect(
        parsePlannerOutput(
            JSON.stringify({
                ...value,
                actors: [plan.actors[0], plan.actors[0]],
            }),
            input,
        ).success,
    ).toBe(false);
    expect(parsePlannerOutput(JSON.stringify(plan), input).success).toBe(false);
});

describe("单图文字与默认风格", () => {
    it("自然台词不再触发禁词错误，构图中的数字进入生图", () => {
        expect(parsePlannerOutput(JSON.stringify(plan), brief).success).toBe(
            true,
        );
        const prompt = renderPrompt(brief);
        expect(prompt).toContain(plan.caption);
        expect(prompt).toContain("牌上写404");
        expect(prompt).toContain("可根据场景补充少量");
        expect(prompt).not.toContain("不要添加其他文字");
    });
    it("none只关闭主台词，不清除场景文字", () => {
        const input: Brief = { ...brief, captionSetting: { mode: "none" } };
        const silent = { ...plan, caption: "" };
        expect(parsePlannerOutput(JSON.stringify(plan), input).success).toBe(
            false,
        );
        expect(parsePlannerOutput(JSON.stringify(silent), input).success).toBe(
            true,
        );
        expect(renderPrompt(input, silent)).toContain("无主台词");
        expect(renderPrompt(input, silent)).toContain("可根据场景补充少量");
    });
    it.each([
        "不要任何文字，角色举空牌",
        "角色举空牌。不要任何文字！",
        "不要任何文字",
    ])("无字要求贯穿构思和生图：%s", (idea) => {
        const input = { ...brief, idea };
        const silent = {
            ...plan,
            caption: "",
            composition: "角色举着空白小牌",
        };
        expect(parsePlannerOutput(JSON.stringify(plan), input).success).toBe(
            false,
        );
        expect(parsePlannerOutput(JSON.stringify(silent), input).success).toBe(
            true,
        );
        expect(
            parsePlannerOutput(
                JSON.stringify({
                    ...silent,
                    propMarks: [
                        { text: "品牌", carrier: "纸牌", placement: "中央" },
                    ],
                }),
                input,
            ).success,
        ).toBe(false);
        expect(captionRule(input)).toContain("优先于配字设置");
        const prompt = renderPrompt(input, silent);
        expect(prompt).toContain("用户要求禁止任何文字");
        expect(prompt).not.toContain("可根据场景补充");
    });
    it("无对白优先于自动配字，场景文字仍可保留", () => {
        const input = { ...brief, idea: "不要对白，角色举牌" };
        expect(parsePlannerOutput(JSON.stringify(plan), input).success).toBe(
            false,
        );
        expect(
            parsePlannerOutput(JSON.stringify({ ...plan, caption: "" }), input)
                .success,
        ).toBe(true);
        expect(captionRule(input)).toContain("用户明确不要台词");
        expect(renderPrompt(input, { ...plan, caption: "" })).toContain(
            "用户要求无对白",
        );
    });
    it("指定台词原样保留，引用的无字台词不误判为无字命令", () => {
        const input: Brief = {
            ...brief,
            idea: "台词：“不要文字”",
            captionSetting: { mode: "custom", text: "不要文字" },
        };
        expect(textRestrictions(input.idea).noText).toBe(false);
        expect(
            parsePlannerOutput(
                JSON.stringify({ ...plan, caption: "不要文字" }),
                input,
            ).success,
        ).toBe(true);
        expect(parsePlannerOutput(JSON.stringify(plan), input).success).toBe(
            false,
        );
    });
    it("白底贴纸只作默认，保留方案背景", () => {
        const prompt = renderPrompt(brief);
        expect(prompt).toContain(
            "风格与背景遵循方案，未指定时采用白底动漫贴纸",
        );
        expect(prompt).toContain("深色机房背景");
        expect(prompt).not.toContain("单张方形、白底");
    });
});

it.each(["auto", "none", "custom", "missing"] as const)(
    "配字策略贯穿三层：%s",
    (mode) => {
        const setting =
            mode === "missing"
                ? undefined
                : mode === "custom"
                  ? { mode, text: "我来修" }
                  : { mode };
        const input: Brief = {
            ...brief,
            idea: "不要对白，角色举牌",
            captionSetting: setting,
        };
        const value = { ...plan, caption: mode === "custom" ? "我来修" : "" };
        expect(parsePlannerOutput(JSON.stringify(value), input).success).toBe(
            true,
        );
        const prompt = renderPrompt(input, value);
        const scenePrompt = sceneImagePrompt(input, {
            scene: "角色举牌",
            actors: plan.actors,
            caption: value.caption,
            propMarks: [],
        });
        if (mode === "custom") {
            expect(captionRule(input)).toContain("text原样");
            expect(prompt).not.toContain("用户要求无对白");
            expect(scenePrompt).not.toContain("用户要求无对白");
            expect(scenePrompt).toContain("我来修");
            expect(
                parsePlannerOutput(
                    JSON.stringify({ ...value, caption: "" }),
                    input,
                ).success,
            ).toBe(false);
        } else {
            expect(prompt).toContain("用户要求无对白");
            expect(scenePrompt).toContain("用户要求无对白");
        }
        const noText = { ...input, idea: "禁止任何文字" };
        expect(captionRule(noText)).toContain("优先于配字设置");
        expect(
            parsePlannerOutput(
                JSON.stringify({ ...value, caption: "" }),
                noText,
            ).success,
        ).toBe(true);
        expect(
            sceneImagePrompt(noText, {
                scene: "角色举空牌",
                actors: plan.actors,
                caption: "",
                propMarks: [],
            }),
        ).toContain("用户要求禁止任何文字");
    },
);
