import { describe, expect, it } from "vitest";
import {
    expandTemplateInspection,
    expandTemplatePlan,
} from "../src/processes/template-from-image/compact.js";
import {
    applyTemplateInspection,
    planDigest,
} from "../src/processes/template-from-image/inspection.js";
import {
    materializeTemplatePlan,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import { candidate, reviewFor } from "./fixtures/template-candidate.js";
import { compactInspection, compactPlan } from "./fixtures/template-compact.js";

describe("紧凑模板传输", () => {
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
            JSON.stringify(plan).length * 0.85,
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
        plan.draft.runtimeSemantics.visualContract.styleTraits[0] =
            "视觉事实".repeat(50);
        expect(expandTemplatePlan(compactPlan(plan))).toEqual(plan);
    });
});
