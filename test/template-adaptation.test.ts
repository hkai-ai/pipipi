import { describe, expect, it } from "vitest";
import {
    expandTemplateInspection,
    expandTemplatePlan,
} from "../src/processes/template-from-image/compact.js";
import { compileTemplateResult } from "../src/processes/template-from-image/contract.js";
import {
    applyTemplateInspection,
    planDigest,
} from "../src/processes/template-from-image/inspection.js";
import {
    materializeTemplatePlan,
    readTemplatePlan,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import { templateRepairContext } from "../src/processes/template-from-image/repair-context.js";
import { candidate, reviewFor } from "./fixtures/template-candidate.js";
import { compactPlan } from "./fixtures/template-compact.js";

describe("原 Skill 的模板适配回归", () => {
    it("身份权限使用具名字段，错误类型和缺轴仍拒绝", () => {
        const plan = toTemplatePlan(candidate());
        const value = compactPlan(plan);
        const named = structuredClone(
            plan.analysis.slotEvidence.subject.featureAuthority,
        );
        Object.assign(value.analysis.slotEvidence.subject, {
            featureAuthority: named,
        });
        expect(expandTemplatePlan(value)).toEqual(plan);
        expect(named).not.toBeNull();
        const missing = structuredClone(value);
        const features = missing.analysis.slotEvidence.subject.featureAuthority;
        if (!features) throw new Error("测试缺少身份权限");
        Reflect.deleteProperty(features, "hair");
        expect(() => expandTemplatePlan(missing)).toThrow();
        const wrong = structuredClone(value);
        const wrongFeatures =
            wrong.analysis.slotEvidence.subject.featureAuthority;
        if (!wrongFeatures) throw new Error("测试缺少身份权限");
        Reflect.set(wrongFeatures.hair, "owner", "unknown");
        expect(() => expandTemplatePlan(wrong)).toThrow();
    });

    it("短而非空的具名复核证据通过最终校验，空白、漏项与失败结论仍拒绝", () => {
        const plan = toTemplatePlan(candidate());
        const { reviewedDraftSha256: _hash, ...review } = reviewFor(
            materializeTemplatePlan(plan),
        );
        review.checks.titlePortable.evidence[0].observation = "可替换";
        const value = {
            reviewedPlanSha256: planDigest(plan),
            changes: [],
            review,
        };
        const image = {
            data: "cG5n",
            mimeType: "image/png" as const,
            width: 800,
            height: 600,
        };
        const check = () =>
            compileTemplateResult(
                applyTemplateInspection(plan, expandTemplateInspection(value)),
                "https://example.com/image.png",
                image,
            );
        expect(check().kind).toBe("PROMPT");
        review.checks.titlePortable.evidence[0].observation = "   ";
        expect(check).toThrow();
        review.checks.titlePortable.evidence[0].observation = "可替换";
        review.checks.titlePortable.passed = false;
        expect(check).toThrow();
        Reflect.deleteProperty(review.checks, "titlePortable");
        expect(check).toThrow();
    });

    it("复核直接消费引用计划，并在引用失效时保留其他修正上下文", () => {
        const plan = toTemplatePlan(candidate());
        const context = templateRepairContext(plan);
        expect(context).not.toBeNull();
        expect(context.slotConstraints).toHaveLength(
            plan.draft.inputSchema.slots.length,
        );
        expect(context.slotConstraints[0].suggestions).toEqual(
            plan.draft.inputSchema.slots[0].text.suggestions,
        );
        plan.analysis.spatialRelations[0].relationIndex = 63;
        const broken = templateRepairContext(plan);
        expect(broken).not.toBeNull();
        expect(broken.unresolvedRelations).toHaveLength(1);
        expect(broken.slotConstraints).toHaveLength(
            plan.draft.inputSchema.slots.length,
        );
    });

    it("非身份内容槽位使用空权限，并在复核上下文中明确不适用", () => {
        const plan = toTemplatePlan(candidate());
        delete plan.draft.inputSchema.slots[0].image;
        Reflect.deleteProperty(
            plan.draft.inputSchema.slots[0],
            "resolutionStrategy",
        );
        Object.assign(plan.draft.runtimeSemantics.inputBindings, {
            subject: {
                operation: "replace_content",
                targetIds: ["subject_main"],
                distributionPolicy: "replace_as_unit",
            },
        });
        plan.analysis.slotEvidence.subject.featureAuthority = null;
        const expanded = expandTemplatePlan(compactPlan(plan));
        const context = templateRepairContext(expanded);
        expect(context.slotConstraints[0].requiresFeatureAuthority).toBe(false);
        expect(context.slotConstraints[0].templateOwnedFeatures).toEqual([]);
        expect(
            readTemplatePlan(expanded).analysis.slotEvidence.subject
                .featureAuthority,
        ).toBeNull();
    });

    it("身份槽位缺少权限仍被业务校验拒绝", () => {
        const plan = toTemplatePlan(candidate());
        plan.analysis.slotEvidence.subject.featureAuthority = null;
        expect(
            readTemplatePlan(plan).analysis.slotEvidence.subject
                .featureAuthority,
        ).toBeNull();
        const { reviewedDraftSha256: _hash, ...review } = reviewFor(
            materializeTemplatePlan(plan),
        );
        expect(() =>
            compileTemplateResult(
                applyTemplateInspection(plan, {
                    reviewedPlanSha256: planDigest(plan),
                    changes: [],
                    review,
                }),
                "https://example.com/image.png",
                {
                    data: "cG5n",
                    mimeType: "image/png",
                    width: 800,
                    height: 600,
                },
            ),
        ).toThrow();
    });
});
