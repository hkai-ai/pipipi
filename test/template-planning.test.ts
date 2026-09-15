import { expect, it } from "vitest";
import {
    planningSchema,
    projectPlanning,
} from "../src/processes/template-from-source/planning.js";
import {
    compileReplacementPrompt,
    parseReplacementStrategy,
    StrategyValidationError,
} from "../src/processes/template-from-source/strategy.js";
import { imageStrategy } from "./fixtures/template-image-strategy.js";

const layout = (contour: string) => ({
    readingDirection: "从左到右一行",
    lineContour: contour,
    baseline: "原图可见落点存在变化",
    glyphShape: "粗重窄字，宽高不完全一致",
    spacing: "紧凑不等距",
    alignment: "小字位于主行下方居中",
});
const action = (contour: string) => ({
    regionId: "caption",
    componentId: "body",
    role: "content",
    action: "replace",
    originalText: "原文",
    exactText: "新文",
    language: "中文",
    location: "中央",
    layout: layout(contour),
    jokeRole: "标语",
    explicitlyAuthorized: true,
    mechanismRequiresRewrite: false,
    genericAttribute: false,
    neutralizationReason: null,
    evidence: "原图可见文字",
});

it.each([
    "中间高两端低",
    "中间低两端高",
    "各字在同一水平线",
    "竖排三列依次错开",
    "模糊无法判断",
])("原图排版观察直接进入持久化合同和最终指令：%s", (contour) => {
    const candidate = { ...imageStrategy(), textActions: [action(contour)] };
    const before = structuredClone(candidate);
    expect(planningSchema.safeParse(candidate).success).toBe(true);
    const strategy = parseReplacementStrategy(projectPlanning(candidate));
    const prompt = compileReplacementPrompt(strategy);
    for (const observation of Object.values(layout(contour))) {
        expect(strategy.textActions[0].layout).toContain(observation);
        expect(prompt).toContain(observation);
    }
    expect(strategy.textActions[0].exactText).toBe("新文");
    expect(candidate).toEqual(before);
    expect(strategy).not.toHaveProperty("sourceTextRegions");
});

it("缺失观察进入既有 textActions 字段修正，不补造事实或吞掉未知字段", () => {
    const { baseline: _, ...incomplete } = layout("水平");
    const candidate = {
        ...imageStrategy(),
        textActions: [{ ...action("水平"), layout: incomplete }],
    };
    expect(projectPlanning(candidate)).toEqual(candidate);
    try {
        parseReplacementStrategy(projectPlanning(candidate));
        expect.fail("必须拒绝缺失观察");
    } catch (error) {
        expect(error).toBeInstanceOf(StrategyValidationError);
        expect((error as StrategyValidationError).issues).toContainEqual({
            code: "invalid_type",
            fields: ["textActions"],
        });
    }
    expect(() =>
        parseReplacementStrategy(
            projectPlanning({ ...imageStrategy(), privateExtra: "unknown" }),
        ),
    ).toThrow();
});

it("无文字原图保持空区域；旧策略字符串不重新解释", () => {
    const empty = imageStrategy();
    expect(projectPlanning(empty)).toEqual(empty);
    const legacy = {
        ...empty,
        textActions: [{ ...action("水平"), layout: "旧审批中的排版原文" }],
    };
    expect(projectPlanning(legacy)).toEqual(legacy);
});

it("模型先观察排版后决定文案，不改变持久化合同", () => {
    const fields = Object.keys(planningSchema.shape.textActions.element.shape);
    expect(Object.keys(planningSchema.shape)[0]).toBe("textActions");
    expect(fields.indexOf("layout")).toBeLessThan(fields.indexOf("exactText"));
    expect(fields.indexOf("originalText")).toBeLessThan(
        fields.indexOf("action"),
    );
});
