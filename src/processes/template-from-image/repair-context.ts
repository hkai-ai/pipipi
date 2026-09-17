/** 从独立分析与引用计划生成复核上下文，定位未落实的观察和失效引用。 */

import { analysisCounts } from "./analysis-contract.js";
import { draftFromPlan, readTemplatePlan } from "./projection.js";
import {
    visualSelectionContext,
    visualSelectionIssues,
} from "./visual-selection.js";

export function templateRepairContext(value: unknown) {
    const plan = readTemplatePlan(value);
    const { analysis } = plan;
    const draft = draftFromPlan(plan);
    const visual = draft.runtimeSemantics.visualContract;
    return {
        counts: analysisCounts({ analysis, draft }),
        visualSelections: visualSelectionContext(analysis, visual),
        visualSelectionIssues: visualSelectionIssues(analysis, visual),
        visualFactMismatches: (
            ["medium", "styleTraits", "composition", "colorAndLight"] as const
        ).flatMap((field) => {
            const selected = analysis.mediumComposition[field];
            const actual = visual[field];
            const missing =
                typeof selected === "string"
                    ? selected === actual
                        ? []
                        : [selected]
                    : selected.filter((fact) => !actual.includes(fact));
            return missing.length
                ? [
                      {
                          sourcePath: `/analysis/mediumComposition/${field}`,
                          targetPath: `/analysis/semanticModel/runtimeSemantics/visualContract/${field}`,
                          selected,
                          actual,
                          missing,
                      },
                  ]
                : [];
        }),
        unresolvedRelations: analysis.spatialRelations.flatMap(
            (relation, index) =>
                visual.relations[relation.relationIndex] === undefined
                    ? [
                          {
                              path: `/analysis/spatialRelations/${index}/relationIndex`,
                              targetPath: `/analysis/semanticModel/runtimeSemantics/visualContract/relations/${relation.relationIndex}`,
                              actual: visual.relations,
                          },
                      ]
                    : [],
        ),
        slotConstraints: draft.inputSchema.slots.map((slot, index) => ({
            slotId: slot.id,
            path: `/draft/inputSchema/slots/${index}/text/suggestions`,
            defaultValue: slot.text.defaultValue,
            suggestions: slot.text.suggestions,
            featurePath: `/analysis/slotEvidence/${slot.id}/featureAuthority`,
            requiresFeatureAuthority:
                draft.runtimeSemantics.inputBindings[slot.id]?.operation ===
                "replace_identity",
            templateOwnedFeatures: Object.entries(
                analysis.slotEvidence[slot.id]?.featureAuthority ?? {},
            )
                .filter(([, feature]) => feature.owner === "template")
                .map(([axis, feature]) => ({
                    axis,
                    basis: feature.basis,
                    runtimeFactRef: feature.runtimeFactRef,
                    runtimeFact: feature.runtimeFactRef
                        ? (visual[feature.runtimeFactRef.field][
                              feature.runtimeFactRef.index
                          ] ?? null)
                        : null,
                })),
            openVisualFacts:
                analysis.slotEvidence[slot.id]?.openVisualFacts ?? [],
        })),
    };
}
