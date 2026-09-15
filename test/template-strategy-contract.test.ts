import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createSkillSet } from "../src/agent-runtime/skills.js";
import { templatePlanProduction } from "../src/processes/template-from-source/production.js";
import {
    compileReplacementPrompt,
    parseReplacementStrategy,
} from "../src/processes/template-from-source/strategy.js";
import { imageStrategy } from "./fixtures/template-image-strategy.js";

it("真实 Skill 装载原入口与五份引用，正文逐文件匹配固定来源", () => {
    const root = ".pi/skills/template-image-preparer/";
    const content = readFileSync(`${root}SKILL.md`, "utf8");
    const manifest = JSON.parse(
        readFileSync(`${root}source-manifest.json`, "utf8"),
    ) as { files: Record<string, string> };
    const sections = [
        ...content.matchAll(
            /<!-- source: ([^>]+) -->\n\n([\s\S]*?)(?=\n<!-- source: |$)/g,
        ),
    ];
    expect(sections.map((section) => section[1])).toEqual([
        "SKILL.md",
        "references/replacement.md",
        "references/prompt-structure.md",
        "references/generation-contract.md",
        "references/reviews-and-revisions.md",
        "references/portable-batch.md",
    ]);
    for (const [, path, body] of sections) {
        const normalized = `${body.trim()}\n`;
        const hashes = [normalized, normalized.replace(/\n/g, "\r\n")].map(
            (text) => createHash("sha256").update(text).digest("hex"),
        );
        expect(hashes, path).toContain(manifest.files[path]);
    }
    const loaded = createSkillSet(
        templatePlanProduction.installedSkills({}),
        process.cwd(),
    ).load();
    expect(loaded.instructions).toContain("先判断某项特征是否承载笑点");
    expect(loaded.instructions).toContain("段落使用简洁可执行的正向语句");
    expect(loaded.instructions).toContain(
        "A new submit always requires a new strategy revision and approval",
    );
});

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

it.each([
    "单行文字沿轻微拱弧排列，字距紧凑",
    "竖向三行，行间错落，边缘保留手刷破边",
    "水平直线排版，等距排列",
])("已批准排版原样进入指令，不按个案改写：%s", (layout) => {
    const s = imageStrategy();
    s.textActions = [
        {
            regionId: "caption",
            componentId: "body",
            role: "content",
            action: "replace",
            originalText: "旧文",
            exactText: "新文",
            language: "中文",
            layout,
            location: "设计中央",
            jokeRole: "标语",
            explicitlyAuthorized: true,
            mechanismRequiresRewrite: false,
            genericAttribute: false,
            neutralizationReason: null,
            evidence: "原图文字区域",
        },
    ];
    const before = structuredClone(s);
    const prompt = compileReplacementPrompt(parseReplacementStrategy(s));
    const marks = prompt
        .split("\n")
        .find((line) => line.startsWith("标记策略："));
    if (!marks) throw new Error("生成指令缺少标记策略段");
    for (const field of [
        "originalText",
        "exactText",
        "layout",
        "location",
        "language",
        "jokeRole",
    ] as const)
        expect(marks).toContain(s.textActions[0][field]);
    for (const value of Object.values(s.visualFeatures))
        expect(prompt).toContain(value);
    for (const item of s.frozenSet) expect(prompt).toContain(item.instruction);
    expect(prompt).not.toContain('"explicitlyAuthorized"');
    expect(prompt).not.toContain('"subjectContinuityEvidence"');
    expect(prompt).not.toContain('"evidence"');
    expect(s).toEqual(before);
});

it("清理指令遵守特征权限，不把重绘范围当成全部设计替换范围", () => {
    const s = imageStrategy();
    s.featureAuthority[0].authority = "template_mechanism";
    s.featureAuthority[0].instruction = "保持猫身被拥抱的轮廓与比例";
    const prompt = compileReplacementPrompt(parseReplacementStrategy(s));
    expect(prompt).toContain(s.featureAuthority[0].instruction);
    expect(prompt).toContain(
        "只清除被 target_identity 接管的旧身份特征和已批准移除的内容",
    );
    expect(prompt).toContain("保留 template_mechanism 的设计");
    expect(prompt).not.toContain("清除旧内容残留");
});
