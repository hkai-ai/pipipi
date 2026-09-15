import { expect, it } from "vitest";
import {
    compileReplacementPrompt,
    parseReplacementStrategy,
} from "../src/processes/template-from-source/strategy.js";
import { imageStrategy } from "./fixtures/template-image-strategy.js";

it.each(["print_artwork", "screen_content"] as const)(
    "%s 拒绝保留载体或外框",
    (route) => {
        const s = imageStrategy();
        s.targetCanvas.route = route;
        s.targetCanvas.carrierRole =
            route === "print_artwork" ? "apparel" : "device";
        expect(() => parseReplacementStrategy(s)).not.toThrow();
        s.frozenSet.push({
            scope: "carrier",
            regionId: "outline",
            instruction: "保留外框",
        });
        expect(() => parseReplacementStrategy(s)).toThrow();
    },
);
it("完整场景需机制理由，普通服饰不能沿用完整场景", () => {
    const s = imageStrategy();
    s.targetCanvas = {
        route: "full_scene",
        carrierRole: "mechanism",
        reason: "拥抱时宠物与双臂接触就是画面玩法",
        targetRegion: "整图",
        excludedScopes: [],
        excludedRegions: [],
    };
    expect(() => parseReplacementStrategy(s)).not.toThrow();
    s.targetCanvas.carrierRole = "apparel";
    expect(() => parseReplacementStrategy(s)).toThrow();
    s.targetCanvas.carrierRole = "mechanism";
    s.targetCanvas.reason = "";
    expect(() => parseReplacementStrategy(s)).toThrow();
});
it("自由指令被拒绝，组件引用及连续性必须对账", () => {
    const s = imageStrategy();
    expect(() =>
        parseReplacementStrategy({
            ...s,
            promptSections: { target: "换成狗" },
        }),
    ).toThrow();
    s.replacementComponentIds = ["missing"];
    expect(() => parseReplacementStrategy(s)).toThrow();
    s.replacementComponentIds = ["body"];
    s.subjectContinuityEvidence[0].target = {
        ...s.subjectContinuityEvidence[0].target,
        ageStage: "幼年",
    };
    expect(() => parseReplacementStrategy(s)).toThrow();
});
it("确定性指令使用批准文字、目标和刻意缺陷", () => {
    const s = imageStrategy();
    s.textActions = [
        {
            regionId: "label",
            componentId: "body",
            role: "content",
            action: "replace",
            originalText: "原文",
            exactText: "新文",
            language: "中文",
            layout: "横排",
            location: "中央",
            jokeRole: "标语",
            explicitlyAuthorized: true,
            mechanismRequiresRewrite: false,
            genericAttribute: false,
            neutralizationReason: null,
            evidence: "中央文字",
        },
    ];
    const prompt = compileReplacementPrompt(parseReplacementStrategy(s));
    expect(prompt.split("\n")).toHaveLength(12);
    for (const text of [
        s.replacementValue,
        "原文",
        "新文",
        s.visualFeatures.intentionalImperfections,
    ])
        expect(prompt).toContain(text);
    s.textActions[0].action = "preserve";
    expect(() => parseReplacementStrategy(s)).toThrow();
    s.textActions[0].exactText = "原文";
    expect(() => parseReplacementStrategy(s)).not.toThrow();
    s.textActions[0].componentId = "missing";
    expect(() => parseReplacementStrategy(s)).toThrow();
});

it("机制组件可重绘并保留姿势特征，冻结不等于禁止重绘", () => {
    const s = imageStrategy();
    s.featureAuthority[0].authority = "template_mechanism";
    s.frozenSet.push({
        scope: "design",
        regionId: "body",
        instruction: "猫身被拥抱的姿势与轮廓保持",
    });
    expect(() => parseReplacementStrategy(s)).not.toThrow();
});
