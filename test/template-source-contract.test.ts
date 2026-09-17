import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    analysisCounts,
    sourceContractIssues,
} from "../src/processes/template-from-image/analysis-contract.js";
import { readTemplateCandidate } from "../src/processes/template-from-image/contract.js";
import {
    materializeTemplatePlan,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import { analysisIssues } from "../src/processes/template-from-image/quality.js";
import { candidate, textRegion } from "./fixtures/template-candidate.js";

describe("原 Skill 分析合同", () => {
    it("来源夹具的语义、原始证据和四种数量在适配后保持一致", () => {
        const source = JSON.parse(
            readFileSync("test/fixtures/template-source-contract.json", "utf8"),
        );
        const value = candidate();
        const original = source.analysis;
        // 组件在 Pi 夹具中命名为 pet；其余共同语义与来源夹具一致。
        value.analysis.visualMechanism = original.visualMechanism;
        value.analysis.fieldEvidence = original.fieldEvidence;
        value.analysis.containers = original.containers;
        value.analysis.fixedStructure = original.fixedStructure;
        value.analysis.promptCoverage = original.promptCoverage;
        value.analysis.translationEquivalences =
            original.translationEquivalences;
        const { componentCoverage: _coverage, ...semantic } =
            original.semanticModel;
        value.analysis.semanticModel = semantic;
        const {
            status: _status,
            imageSize: _size,
            imageN: _count,
            kind: _kind,
            preprocessSteps: _steps,
            ...draft
        } = source.formalDraft;
        value.draft = draft;
        const result = materializeTemplatePlan(toTemplatePlan(value));
        expect(result.analysis.fieldEvidence).toEqual(original.fieldEvidence);
        expect(result.draft.promptTemplate).toBe(
            original.semanticModel.promptTemplate,
        );
        expect(result.draft.runtimeSemantics).toEqual(
            original.semanticModel.runtimeSemantics,
        );
        expect(analysisCounts(result)).toEqual(original.counts);
        expect(analysisIssues(result)).toEqual([]);
    });

    it.each([
        ["水印保留", "watermark", "preserve", "fixed", "水印必须删除"],
        ["歧义开放", "ambiguous", "open_slot", "high", "歧义文字必须待辨识"],
        ["动作价值不符", "content", "remove", "high", "文字价值与路由不一致"],
    ] as const)("原路由拒绝%s", (_name, role, action, editValue, error) => {
        const value = candidate();
        value.analysis.textRegions.push({
            ...textRegion(),
            role,
            action,
            editValue,
        });
        expect(sourceContractIssues(value).join()).toContain(error);
    });

    it("同一文字语义单元的角色必须一致", () => {
        const value = candidate();
        const region = {
            ...textRegion(),
            action: "remove" as const,
            editValue: "none" as const,
        };
        value.analysis.textRegions.push(region, {
            ...region,
            id: "caption2",
            semanticUnitRole: "supporting_copy",
        });
        expect(analysisIssues(value).join()).toContain("同一语义单元");
    });

    it("删除文字仍保留布局观察，观察不要求逐字成为冻结规则", () => {
        const value = candidate();
        value.analysis.textRegions.push({
            ...textRegion(),
            role: "watermark",
            action: "remove",
            editValue: "none",
        });
        expect(analysisIssues(value)).toEqual([]);
        const plan = toTemplatePlan(value);
        Reflect.deleteProperty(plan.analysis.textRegions[0], "position");
        expect(() => materializeTemplatePlan(plan)).toThrow("position");
    });

    it("翻译关联由观察决定，服务端绑定原文摘要并拒绝过期证据", () => {
        const value = candidate();
        const region = {
            ...textRegion(),
            action: "remove" as const,
            editValue: "none" as const,
        };
        value.analysis.textRegions = [
            region,
            {
                ...region,
                id: "translation",
                semanticUnitId: "translation",
                language: "en",
                exactText: "Hello",
                translationSourceRegionId: region.id,
            },
        ];
        const plan = toTemplatePlan(value);
        plan.analysis.translationEquivalences = [
            { sourceRegionId: region.id, targetRegionIds: ["translation"] },
        ];
        const result = materializeTemplatePlan(plan);
        expect(analysisIssues(result)).toEqual([]);
        expect(
            result.analysis.translationEquivalences[0].sourceTextSha256,
        ).toBe(createHash("sha256").update(region.exactText).digest("hex"));
        result.analysis.textRegions[1].exactText = "Changed";
        expect(analysisIssues(result).join()).toContain("原文摘要已失效");
        result.analysis.translationEquivalences = [];
        expect(analysisIssues(result).join()).toContain("缺少准确证据");
    });

    it.each([
        [
            "动态来源",
            (v: ReturnType<typeof candidate>) => {
                v.analysis.semanticModel.dynamicFactSources.subject = "another";
            },
            "dynamicFactSources",
        ],
        [
            "图片隔离",
            (v: ReturnType<typeof candidate>) => {
                v.analysis.semanticModel.sourceIsolationByInput.subject = false;
            },
            "sourceIsolationByInput",
        ],
        [
            "身份重绘",
            (v: ReturnType<typeof candidate>) => {
                v.analysis.semanticModel.completeRedrawByTarget = {};
            },
            "completeRedrawByTarget",
        ],
        [
            "推荐项语义",
            (v: ReturnType<typeof candidate>) => {
                v.analysis.slotEvidence.subject.substitutions[0].sameAxis = false;
            },
            "语义代入",
        ],
        [
            "默认语言",
            (v: ReturnType<typeof candidate>) => {
                v.analysis.slotEvidence.subject.defaultLanguageReview.natural = false;
            },
            "defaultLanguageReview",
        ],
        [
            "输入模式",
            (v: ReturnType<typeof candidate>) => {
                v.analysis.slotEvidence.subject.inputModeDecision.modes = [
                    "text",
                ];
            },
            "inputModeDecision",
        ],
        [
            "开放事实",
            (v: ReturnType<typeof candidate>) => {
                v.analysis.slotEvidence.subject.openVisualFacts = [];
            },
            "openVisualFacts",
        ],
        [
            "标题门禁",
            (v: ReturnType<typeof candidate>) => {
                v.analysis.titleEvidence.userAppeal.passed = false;
            },
            "titleEvidence",
        ],
        [
            "自由编辑覆盖",
            (v: ReturnType<typeof candidate>) => {
                v.analysis.promptCoverage.freeEditableRegionIds = ["missing"];
            },
            "freeEditableRegionIds",
        ],
    ] as const)("保留原%s门禁", (_name, mutate, error) => {
        const value = candidate();
        mutate(value);
        expect(analysisIssues(value).join()).toContain(error);
    });

    it("语言脚本冲突被拒绝，汉字与日语歧义留给语义复核", () => {
        const value = candidate();
        value.draft.inputSchema.slots[0].text.suggestions[0] = "cat";
        expect(sourceContractIssues(value).join()).toContain("语言脚本");
        value.draft.inputSchema.slots[0].text.suggestions[0] = "ねこ";
        expect(sourceContractIssues(value).join()).not.toContain("语言脚本");
    });

    it("原字段证据缺项不能由草稿回填", () => {
        const value = candidate();
        Reflect.deleteProperty(value.analysis.fieldEvidence, "visualContract");
        expect(() => readTemplateCandidate(value)).toThrow();
    });

    it("编译前观察必须由模型填写且不进入正式草稿", () => {
        const value = candidate();
        const parsed = readTemplateCandidate(value);
        expect(parsed.analysis.imageObservation).toBe(
            value.analysis.imageObservation,
        );
        expect(parsed.draft).not.toHaveProperty("imageObservation");
        Reflect.deleteProperty(value.analysis, "imageObservation");
        expect(() => readTemplateCandidate(value)).toThrow();
    });

    it("快速文字长度只约束文字区域槽，身份描述不套用该门禁", () => {
        const value = candidate();
        value.draft.inputSchema.slots[0].text.defaultValue =
            "可辨认特征".repeat(8);
        expect(sourceContractIssues(value).join()).not.toContain("文字过长");
        value.analysis.textRegions = [
            {
                ...textRegion(),
                action: "open_slot",
                editValue: "high",
                slotId: "subject",
            },
        ];
        expect(sourceContractIssues(value).join()).toContain("文字过长");
    });

    it("重复出现的同一身份不增加上传数量和控件数量", () => {
        const value = candidate();
        value.analysis.identityTopology[0].instanceIds.push("second_instance");
        expect(analysisCounts(value)).toEqual({
            identityCount: 1,
            visualInstanceCount: 2,
            uploadAssetCount: 1,
            inputControlCount: 1,
        });
    });
});
