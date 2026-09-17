import { describe, expect, it } from "vitest";
import {
    expandTemplateInspection,
    templateInspectionResponseSchema,
} from "../src/processes/template-from-image/compact.js";
import { compileTemplateResult } from "../src/processes/template-from-image/contract.js";
import {
    applyTemplateInspection,
    planDigest,
} from "../src/processes/template-from-image/inspection.js";
import {
    materializeTemplatePlan,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import { reviewIssues } from "../src/processes/template-from-image/quality.js";
import { templateRepairContext } from "../src/processes/template-from-image/repair-context.js";
import { visualSelectionIssues } from "../src/processes/template-from-image/visual-selection.js";
import { candidate, reviewFor } from "./fixtures/template-candidate.js";
import { compactInspection } from "./fixtures/template-compact.js";

describe("原始视觉观察到稳定规则的取舍", () => {
    it("新观察没有取舍时明确报告，不再仅检查已选规则", () => {
        const plan = toTemplatePlan(candidate());
        plan.analysis.fieldEvidence.visualContract.push(
            "局部颜色来自可替换的动物外观",
        );
        const context = templateRepairContext(plan);
        expect(context.visualFactMismatches).toEqual([]);
        expect(context.visualSelectionIssues.join()).toContain("有且只有一个");
        expect(context.visualSelections[1].decisions).toEqual([]);
    });

    it.each(["直线排列", "中部抬高的浅弧排列", "两块错位的分栏排列"])(
        "保留%s依据且不替模型推断其他形状",
        (layout) => {
            const plan = toTemplatePlan(candidate());
            const before = structuredClone(plan);
            plan.analysis.fieldEvidence.visualContract.push(layout);
            plan.analysis.visualSelections.push({
                evidenceIndex: 1,
                decision: "retain",
                reason: "该整体排列承担阅读关系",
                factRefs: [{ field: "composition", index: 0 }],
            });
            const context = templateRepairContext(plan);
            expect(context.visualSelectionIssues).toEqual([]);
            expect(context.visualSelections[1].observation).toBe(layout);
            expect(context.visualSelections[1].decisions[0].facts[0].fact).toBe(
                before.analysis.semanticModel.runtimeSemantics.visualContract
                    .composition[0],
            );
            // 引用合法不证明语义一致，程序不把 layout 拼入正式合同。
            expect(materializeTemplatePlan(plan).draft).toEqual(
                candidate().draft,
            );
        },
    );

    it("允许舍弃水印或开放外观，仍保留原始依据和理由", () => {
        const plan = toTemplatePlan(candidate());
        plan.analysis.fieldEvidence.visualContract.push("右下角有作者水印");
        plan.analysis.visualSelections.push({
            evidenceIndex: 1,
            decision: "omit",
            reason: "作者水印不承载玩法，沿用来源删除规则",
            factRefs: [],
        });
        const context = templateRepairContext(plan);
        expect(context.visualSelectionIssues).toEqual([]);
        expect(context.visualSelections[1].decisions[0].decision).toBe("omit");
        expect(materializeTemplatePlan(plan).draft).toEqual(candidate().draft);
    });

    it("拒绝重复决定、未落实保留项及已舍弃却冻结的项目", () => {
        const value = candidate();
        const check = () =>
            visualSelectionIssues(
                value.analysis,
                value.draft.runtimeSemantics.visualContract,
            );
        value.analysis.visualSelections.push(
            structuredClone(value.analysis.visualSelections[0]),
        );
        expect(check().join()).toContain("有且只有一个");
        value.analysis.visualSelections.pop();
        value.analysis.visualSelections[0].factRefs[0].index = 63;
        expect(check().join()).toContain("存在的正式");
        value.analysis.visualSelections[0].decision = "omit";
        expect(check().join()).toContain("舍弃项不得");
        value.analysis.visualSelections[0].decision = "retain";
        value.analysis.visualSelections[0].factRefs = [];
        expect(check().join()).toContain("存在的正式");
    });

    it("媒介引用只能用 null，数组引用必须有实际索引", () => {
        const plan = toTemplatePlan(candidate());
        plan.analysis.visualSelections[0].factRefs = [
            { field: "medium", index: null },
        ];
        expect(templateRepairContext(plan).visualSelectionIssues).toEqual([]);
        plan.analysis.visualSelections[0].factRefs[0].index = 0;
        expect(templateRepairContext(plan).visualSelectionIssues).toHaveLength(
            1,
        );
    });

    it("独立复核不得跳过原始观察或取舍理由，失败结论不能被引用一致覆盖", () => {
        const value = candidate();
        const plan = toTemplatePlan(value);
        const { reviewedDraftSha256: _, ...review } = reviewFor(value);
        const response = compactInspection({
            reviewedPlanSha256: planDigest(plan),
            changes: [],
            review,
        });
        const schema = templateInspectionResponseSchema(plan, planDigest(plan));
        expect(schema.safeParse(response).success).toBe(true);
        response.review.checks.visualContractRespectsInputs.evidence.observations =
            [];
        expect(schema.safeParse(response).success).toBe(false);
        expect(() => expandTemplateInspection(response)).toThrow(
            "observations",
        );
        const missing = reviewFor(value);
        missing.checks.visualContractRespectsInputs.evidence.shift();
        expect(reviewIssues(value, missing).join()).toContain("缺少");
        const failed = reviewFor(value);
        failed.checks.visualContractRespectsInputs.passed = false;
        failed.checks.visualContractRespectsInputs.evidence[1].observation =
            "整行形态未记录，无法确认舍弃理由";
        expect(reviewIssues(value, failed).join()).toContain("未通过");
    });

    it("本次复核可修正遗漏并保留无关内容，审核依据不进入公开模板", () => {
        const original = toTemplatePlan(candidate());
        const updated = structuredClone(original);
        updated.analysis.fieldEvidence.visualContract.push(
            "主体边缘保留细小不规则笔触",
        );
        const visual =
            updated.analysis.semanticModel.runtimeSemantics.visualContract;
        const index = visual.styleTraits.length;
        visual.styleTraits.push("主体边缘沿用细小不规则笔触");
        updated.analysis.mediumComposition.styleTraits.push(
            visual.styleTraits[index],
        );
        updated.analysis.visualSelections.push({
            evidenceIndex: 1,
            decision: "retain",
            reason: "边缘笔触使替换主体继续属于手绘媒介",
            factRefs: [{ field: "styleTraits", index }],
        });
        const final = materializeTemplatePlan(updated);
        const { reviewedDraftSha256: _, ...review } = reviewFor(final);
        const result = applyTemplateInspection(original, {
            reviewedPlanSha256: planDigest(original),
            changes: [
                {
                    path: "/analysis/fieldEvidence",
                    value: updated.analysis.fieldEvidence,
                },
                {
                    path: "/analysis/visualSelections",
                    value: updated.analysis.visualSelections,
                },
                {
                    path: "/analysis/mediumComposition",
                    value: updated.analysis.mediumComposition,
                },
                {
                    path: "/analysis/semanticModel",
                    value: updated.analysis.semanticModel,
                },
            ],
            review,
        });
        const template = compileTemplateResult(
            result,
            "https://example.com/template.png",
            { data: "cG5n", mimeType: "image/png", width: 800, height: 600 },
        );
        expect(template.inputSchema).toEqual(candidate().draft.inputSchema);
        expect(template.runtimeSemantics.visualContract.styleTraits).toContain(
            visual.styleTraits[index],
        );
        expect(JSON.stringify(template)).not.toContain("visualSelections");
        expect(original.analysis.fieldEvidence.visualContract).toHaveLength(1);
    });
});
