import { toTemplatePlan } from "../../src/processes/template-from-image/projection.js";
import { candidate } from "./template-candidate.js";

export function compactPlan(plan = toTemplatePlan(candidate())) {
    const a = plan.analysis;
    return {
        draft: structuredClone(plan.draft),
        analysis: {
            ...structuredClone(a),
            componentGraph: a.componentGraph.map((x) => [
                x.id,
                x.evidence,
                x.visualFields,
            ]),
            spatialRelations: a.spatialRelations.map((x) => [
                x.componentIds,
                x.evidence,
                x.relationIndex,
            ]),
            slotCoverageReview: Object.fromEntries(
                Object.entries(a.slotCoverageReview).map(([k, x]) => [
                    k,
                    [x.componentIds, x.slotIds, x.evidence],
                ]),
            ),
            editableCandidates: a.editableCandidates.map((x) => ({
                ...x,
                gates: [
                    x.gates.userMotivation,
                    x.gates.independentUserChoice,
                    x.gates.meaningfulVariation,
                    x.gates.visuallyVisible,
                    x.gates.modelControllable,
                    x.gates.mechanismPreserved,
                ].map((g) => [g.passed, g.evidence]),
            })),
            slotEvidence: Object.fromEntries(
                Object.entries(a.slotEvidence).map(([k, x]) => [
                    k,
                    {
                        ...x,
                        featureAuthority:
                            x.featureAuthority === null
                                ? null
                                : Object.fromEntries(
                                      Object.entries(x.featureAuthority).map(
                                          ([axis, f]) => [
                                              axis,
                                              [
                                                  f.owner,
                                                  f.basis,
                                                  f.evidence,
                                                  f.runtimeFactRef,
                                              ],
                                          ],
                                      ),
                                  ),
                        substitutions: x.substitutions.map((s) => [
                            s.value,
                            s.evidence,
                        ]),
                    },
                ]),
            ),
            tagEvidence: Object.fromEntries(
                Object.entries(a.tagEvidence).map(([k, x]) => [
                    k,
                    [x.visualEvidence, x.searchIntent, x.category],
                ]),
            ),
        },
    };
}

export function compactInspection<
    T extends {
        review: {
            checks: Record<
                string,
                {
                    passed: boolean;
                    evidence: { path: string; observation: string }[];
                }
            >;
            issues: string[];
        };
    },
>(value: T) {
    return {
        ...value,
        review: {
            issues: value.review.issues,
            checks: Object.fromEntries(
                Object.entries(value.review.checks).map(([k, c]) => [
                    k,
                    [c.passed, c.evidence.map((e) => [e.path, e.observation])],
                ]),
            ),
        },
    };
}
