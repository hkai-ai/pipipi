import type { TemplateCandidate } from "../../src/processes/template-from-image/quality.js";
import { candidate, reviewFor } from "./template-candidate.js";

export function ownershipReview(value: TemplateCandidate) {
    const review = reviewFor(value);
    review.checks.visualContractRespectsInputs.evidence.push({
        path: "/analysis/semanticModel/runtimeSemantics/targetInstances",
        observation:
            "原主体外观只在 appearance，抬手姿势归 pose，替换后不保留原物种或毛色。",
    });
    return review;
}

export function ownershipCandidate() {
    const value = candidate();
    const runtime = value.draft.runtimeSemantics;
    runtime.version = 3;
    const target = runtime.targetInstances[0];
    target.appearance = ["红色短毛，尖耳和圆脸"];
    target.pose = ["右手抬起，站在画面中央"];
    for (const field of ["appearance", "pose"] as const) {
        const evidenceIndex =
            value.analysis.fieldEvidence.visualContract.length;
        const fact = target[field]?.[0];
        if (!fact) throw new Error("归属测试缺少事实");
        value.analysis.fieldEvidence.visualContract.push(fact);
        value.analysis.visualSelections.push({
            evidenceIndex,
            decision: "retain",
            reason:
                field === "appearance"
                    ? "原主体未替换时保留其外观"
                    : "新主体保持可见动作和位置",
            factRefs: [{ targetId: target.id, field, index: 0 }],
        });
    }
    value.analysis.semanticModel.runtimeSemantics = structuredClone(runtime);
    value.review = ownershipReview(value);
    return value;
}
