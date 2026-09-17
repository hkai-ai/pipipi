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
        changes: readonly { path: string; value: unknown }[];
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
        ...structuredClone(value),
        review: {
            ...structuredClone(value.review),
            checks: {
                ...structuredClone(value.review.checks),
                visualContractRespectsInputs: {
                    ...structuredClone(
                        value.review.checks.visualContractRespectsInputs,
                    ),
                    evidence: {
                        observations:
                            value.review.checks.visualContractRespectsInputs.evidence.filter(
                                (item) =>
                                    item.path.startsWith(
                                        "/analysis/fieldEvidence/visualContract",
                                    ),
                            ),
                        selections:
                            value.review.checks.visualContractRespectsInputs.evidence.filter(
                                (item) =>
                                    item.path.startsWith(
                                        "/analysis/visualSelections",
                                    ),
                            ),
                        visualContract:
                            value.review.checks.visualContractRespectsInputs.evidence.filter(
                                (item) =>
                                    item.path.startsWith(
                                        "/analysis/semanticModel/runtimeSemantics/visualContract",
                                    ),
                            ),
                    },
                },
                slotRecallComplete: {
                    ...structuredClone(value.review.checks.slotRecallComplete),
                    evidence: Object.fromEntries(
                        value.review.checks.slotRecallComplete.evidence.map(
                            (item) => [
                                item.path.split("/")[3],
                                structuredClone(item),
                            ],
                        ),
                    ),
                },
            },
        },
        changes: value.changes.map(({ path, value }) => ({
            path,
            valueJson: JSON.stringify(value),
        })),
    };
}
