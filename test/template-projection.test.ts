import { describe, expect, it } from "vitest";
import { applyTemplateCorrection } from "../src/processes/template-from-image/correction.js";
import {
    materializeTemplatePlan,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import { analysisIssues } from "../src/processes/template-from-image/quality.js";
import { templateRepairContext } from "../src/processes/template-from-image/repair-context.js";
import { candidate } from "./fixtures/template-candidate.js";

describe("模板事实投影", () => {
    it("目标范围只声明一次，同时生成组件关联和槽位范围", () => {
        const plan = toTemplatePlan(candidate());
        plan.analysis.componentGraph.push({
            id: "sparkles",
            evidence: "画面周围的星芒受同一输入控制",
            visualFields: ["colorAndLight"],
        });
        plan.analysis.targetScopes.subject_main.push("sparkles");
        const result = materializeTemplatePlan(plan);
        expect(result.analysis.componentGraph.at(-1)?.targetIds).toEqual([
            "subject_main",
        ]);
        expect(result.analysis.slotEvidence.subject.componentIds).toEqual([
            "pet",
            "sparkles",
        ]);
        plan.analysis.targetScopes.subject_main.push("missing");
        expect(() => materializeTemplatePlan(plan)).toThrow(
            "targetScopes/subject_main",
        );
    });
    it("修正上下文定位缺失关系，并呈现推荐值不能依赖的模板特征", () => {
        const value = candidate();
        value.analysis.spatialRelations[0].runtimeFact = "抬下巴而非向上看";
        const hair = value.analysis.slotEvidence.subject.featureAuthority?.hair;
        if (!hair) throw new Error("测试缺少头发权限");
        hair.owner = "template";
        hair.runtimeFact = "头发转换为火焰";
        const context = templateRepairContext(value);
        expect(context?.unresolvedRelations[0]).toMatchObject({
            path: "/analysis/spatialRelations/0/runtimeFact",
            expected: "抬下巴而非向上看",
            actual: value.draft.runtimeSemantics.visualContract.relations,
        });
        expect(context?.slotConstraints[0].templateOwnedFeatures).toEqual([
            expect.objectContaining({
                axis: "hair",
                runtimeFact: "头发转换为火焰",
            }),
        ]);
    });
    it("一次修改空间关系同时更新分析与正式语义，未涉及内容不变", () => {
        const original = candidate();
        const plan = toTemplatePlan(original);
        const corrected = applyTemplateCorrection(plan, {
            changes: [
                {
                    path: "/draft/runtimeSemantics/visualContract/relations/0",
                    value: "双臂环抱中央主体",
                },
            ],
        });
        const result = materializeTemplatePlan(corrected);
        expect(result.analysis.spatialRelations[0].runtimeFact).toBe(
            "双臂环抱中央主体",
        );
        expect(result.analysis.semanticModel.runtimeSemantics).toEqual(
            result.draft.runtimeSemantics,
        );
        expect(result.draft.inputSchema).toEqual(original.draft.inputSchema);
        expect(analysisIssues(result)).toEqual([]);
        expect(original.analysis.spatialRelations[0].runtimeFact).toBe(
            "保持拥抱接触",
        );
    });
    it("只修改正式 Prompt，程序重建所有推荐项代入并保留其他槽位", () => {
        const plan = toTemplatePlan(candidate());
        plan.draft.promptTemplate =
            '抱住{{ subject | "橘白猫" }}，旁边写着{{ caption | "你好" }}。';
        const result = materializeTemplatePlan(plan);
        expect(
            result.analysis.slotEvidence.subject.substitutions[0].prompt,
        ).toBe('抱住三花猫，旁边写着{{ caption | "你好" }}。');
        expect(result.analysis.semanticModel.promptTemplate).toBe(
            plan.draft.promptTemplate,
        );
    });
    it("不存在的引用明确指出路径与目标，不追加或猜测事实", () => {
        const plan = toTemplatePlan(candidate());
        plan.analysis.spatialRelations[0].relationIndex = 99;
        expect(() => materializeTemplatePlan(plan)).toThrow(
            /spatialRelations\/0\/relationIndex/,
        );
        expect(
            plan.draft.runtimeSemantics.visualContract.relations,
        ).toHaveLength(2);
    });
    it("模板拥有的特征引用随正式约束更新，开放值冲突仍被校验拦截", () => {
        const original = candidate();
        const hair =
            original.analysis.slotEvidence.subject.featureAuthority?.hair;
        if (!hair) throw new Error("测试缺少头发权限");
        hair.owner = "template";
        hair.basis = "explicit_transformation";
        hair.runtimeFact = "头发转换为火焰";
        original.draft.runtimeSemantics.visualContract.relations.push(
            hair.runtimeFact,
        );
        const plan = toTemplatePlan(original);
        plan.draft.runtimeSemantics.visualContract.relations[2] =
            "头发转换为蓝色火焰";
        const result = materializeTemplatePlan(plan);
        expect(
            result.analysis.slotEvidence.subject.featureAuthority?.hair
                .runtimeFact,
        ).toBe("头发转换为蓝色火焰");
        result.analysis.slotEvidence.subject.openVisualFacts.push("蓝色火焰");
        expect(analysisIssues(result).join()).toContain("开放事实");
    });
});
