import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    compactAnalysisSchema,
    expandTemplateInspection,
    expandTemplatePlan,
    templateInspectionResponseSchema,
} from "../src/processes/template-from-image/compact.js";
import { TemplateContractError } from "../src/processes/template-from-image/contract.js";
import {
    applyTemplateInspection,
    planDigest,
} from "../src/processes/template-from-image/inspection.js";
import {
    materializeTemplatePlan,
    readTemplatePlan,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import { reviewAxes } from "../src/processes/template-from-image/quality.js";
import {
    candidate,
    reviewFor,
    textRegion,
} from "./fixtures/template-candidate.js";
import { compactInspection, compactPlan } from "./fixtures/template-compact.js";

describe("紧凑模板传输", () => {
    it("模型先收到逐区观察再做取舍，重排请求字段不改变计划内容或摘要", () => {
        const schema = z.toJSONSchema(compactAnalysisSchema);
        const keys = Object.keys(schema.properties ?? {});
        for (const [before, after] of [
            ["imageObservation", "componentGraph"],
            ["componentGraph", "fieldEvidence"],
            ["textRegions", "fieldEvidence"],
            ["fieldEvidence", "mediumComposition"],
            ["mediumComposition", "visualSelections"],
            ["visualSelections", "semanticModel"],
        ]) {
            expect(keys).toContain(before);
            expect(keys.indexOf(before)).toBeLessThan(keys.indexOf(after));
        }
        const plan = toTemplatePlan(candidate());
        const compact = compactPlan(plan);
        const reordered = compactAnalysisSchema.parse(compact.analysis);
        const expanded = expandTemplatePlan({
            ...compact,
            analysis: reordered,
        });
        expect(expanded).toEqual(expandTemplatePlan(compact));
        expect(planDigest(readTemplatePlan(expanded))).toBe(planDigest(plan));
    });

    it.each([1, 64])(
        "含 %i 个分析项的复核仍可引用原始观察与正式约束",
        (count) => {
            const value = candidate();
            value.analysis.textRegions.push(textRegion());
            const plan = toTemplatePlan(value);
            plan.analysis.componentGraph = Array.from({ length: count }, () =>
                structuredClone(plan.analysis.componentGraph[0]),
            );
            plan.analysis.editableCandidates = Array.from(
                { length: count },
                () => structuredClone(plan.analysis.editableCandidates[0]),
            );
            plan.analysis.textRegions = Array.from({ length: count }, () =>
                structuredClone(plan.analysis.textRegions[0]),
            );
            const { reviewedDraftSha256: _, ...review } = reviewFor(value);
            const response = compactInspection({
                reviewedPlanSha256: planDigest(plan),
                changes: [],
                review,
            });
            const validate = new Ajv2020().compile(
                z.toJSONSchema(
                    templateInspectionResponseSchema(plan, planDigest(plan)),
                ),
            );
            const observation = {
                path: "/analysis/textRegions/0",
                observation: "文字区域的实际排版",
            };
            const constraint = {
                path: "/analysis/semanticModel/runtimeSemantics/visualContract",
                observation: "正式约束中的对应排版",
            };
            const withEvidence = (evidence: unknown) => ({
                ...response,
                review: {
                    ...response.review,
                    checks: {
                        ...response.review.checks,
                        slotRecallComplete: {
                            passed: true,
                            evidence: Object.fromEntries(
                                reviewAxes.map((axis) => [
                                    axis,
                                    {
                                        path: `/analysis/slotCoverageReview/${axis}`,
                                        observation: `${axis} 轴的实际取舍依据`,
                                    },
                                ]),
                            ),
                        },
                        textEditLayersComplete: { passed: true, evidence },
                    },
                },
            });
            expect(
                validate(
                    withEvidence([
                        observation,
                        {
                            ...constraint,
                            path: "/analysis/semanticModel/runtimeSemantics",
                        },
                    ]),
                ),
            ).toBe(false);
            const grouped = withEvidence({
                textRegions: [observation],
                visualContract: [constraint],
            });
            expect(validate(grouped)).toBe(true);
            expect(
                validate(
                    withEvidence({
                        textRegions: [observation],
                        visualContract: [],
                    }),
                ),
            ).toBe(false);
            expect(
                expandTemplateInspection(grouped).review.checks
                    .textEditLayersComplete.evidence,
            ).toEqual([observation, constraint]);
        },
    );
    it("八轴复核逐项约束路径且无损展开，缺项或只引父对象不得通过", () => {
        const plan = toTemplatePlan(candidate());
        const { reviewedDraftSha256: _, ...review } = reviewFor(candidate());
        const base = compactInspection({
            reviewedPlanSha256: planDigest(plan),
            changes: [],
            review,
        });
        const validate = new Ajv2020().compile(
            z.toJSONSchema(
                templateInspectionResponseSchema(plan, planDigest(plan)),
            ),
        );
        const evidence = Object.fromEntries(
            reviewAxes.map((axis) => [
                axis,
                {
                    path: `/analysis/slotCoverageReview/${axis}`,
                    observation: `${axis} 轴的实际取舍依据`,
                },
            ]),
        );
        const wire = {
            ...base,
            review: {
                ...base.review,
                checks: {
                    ...base.review.checks,
                    slotRecallComplete: { passed: true, evidence },
                },
            },
        };
        expect(validate(wire)).toBe(true);
        expect(
            expandTemplateInspection(wire).review.checks.slotRecallComplete
                .evidence,
        ).toEqual(Object.values(evidence));
        const missing = structuredClone(wire);
        delete missing.review.checks.slotRecallComplete.evidence.object;
        expect(validate(missing)).toBe(false);
        const wrong = structuredClone(wire);
        wrong.review.checks.slotRecallComplete.evidence.object.path =
            "/analysis/slotCoverageReview";
        expect(validate(wrong)).toBe(false);
    });
    it("缺少必需视觉合同立即拒绝，不能发送空枚举的复核 Schema", () => {
        expect(() =>
            templateInspectionResponseSchema(
                { analysis: { textRegions: [{ id: "title" }] }, draft: {} },
                "0".repeat(64),
            ),
        ).toThrow(TemplateContractError);
    });
    it("补丁值按 JSON 无损读回，格式错误不得被补填或忽略", () => {
        const plan = toTemplatePlan(candidate());
        const { reviewedDraftSha256: _, ...review } = reviewFor(
            materializeTemplatePlan(plan),
        );
        const full = {
            reviewedPlanSha256: planDigest(plan),
            changes: [
                { path: "/draft/title", value: '你好"世界' },
                {
                    path: "/analysis/targetScopes",
                    value: { a: [1, false, null] },
                },
            ],
            review,
        };
        const wire = compactInspection(full);
        expect(expandTemplateInspection(wire)).toEqual(full);
        expect(() =>
            expandTemplateInspection({
                ...wire,
                changes: [{ path: "/draft/title", valueJson: "not JSON" }],
            }),
        ).toThrow();
        expect(() =>
            expandTemplateInspection({
                ...wire,
                changes: [["/draft/title", '"你好"']],
            }),
        ).toThrow();
    });
    it("全部分析逐值还原，包括否定门禁和空权限，不更改正式草稿", () => {
        const plan = toTemplatePlan(candidate());
        plan.analysis.editableCandidates[0].gates.visuallyVisible.passed = false;
        const compact = compactPlan(plan);
        expect(expandTemplatePlan(compact)).toEqual(plan);
        expect(JSON.stringify(compact).length).toBeLessThan(
            JSON.stringify(plan).length,
        );
    });
    it("少一个门禁、错位值或漏轴都拒绝，不补成通过", () => {
        const short = compactPlan();
        short.analysis.editableCandidates[0].gates.pop();
        expect(() => expandTemplatePlan(short)).toThrow();
        const wrong = compactPlan();
        wrong.analysis.editableCandidates[0].gates[0] = ["证据写反了", true];
        expect(() => expandTemplatePlan(wrong)).toThrow();
        const missing = compactPlan();
        delete missing.analysis.slotCoverageReview.text;
        expect(() => expandTemplatePlan(missing)).toThrow();
    });
    it("报告保留全部十九项原始结论和证据，未解决问题仍拒绝", () => {
        const plan = toTemplatePlan(candidate());
        const { reviewedDraftSha256: _hash, ...review } = reviewFor(
            materializeTemplatePlan(plan),
        );
        review.checks.tagsValid.passed = false;
        review.issues.push("标签含开放内容");
        const full = {
            reviewedPlanSha256: planDigest(plan),
            changes: [],
            review,
        };
        expect(expandTemplateInspection(compactInspection(full))).toEqual(full);
        const missing = compactInspection(full);
        delete missing.review.checks.tagsValid;
        expect(() => expandTemplateInspection(missing)).toThrow();
        const bad = compactInspection(full);
        bad.reviewedPlanSha256 = "0".repeat(64);
        expect(() =>
            applyTemplateInspection(plan, expandTemplateInspection(bad)),
        ).toThrow();
    });
    it("紧凑证据超限有具体路径，正式视觉事实仍可完整表达", () => {
        const value = compactPlan();
        value.analysis.componentGraph[0][1] = "长".repeat(97);
        expect(() => expandTemplatePlan(value)).toThrow("componentGraph");
        const plan = toTemplatePlan(candidate());
        plan.analysis.semanticModel.runtimeSemantics.visualContract.styleTraits[0] =
            "视觉事实".repeat(50);
        expect(expandTemplatePlan(compactPlan(plan))).toEqual(plan);
    });
});
