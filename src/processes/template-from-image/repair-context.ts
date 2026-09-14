/** 从引用计划生成复核上下文，引用失效时仍保留槽位约束与可定位的修正信息。 */
import { readTemplatePlan } from "./projection.js";

export function templateRepairContext(value: unknown) {
    const { draft, analysis } = readTemplatePlan(value);
    const visual = draft.runtimeSemantics.visualContract;
    return {
        unresolvedRelations: analysis.spatialRelations.flatMap(
            (relation, index) =>
                visual.relations[relation.relationIndex] === undefined
                    ? [
                          {
                              path: `/analysis/spatialRelations/${index}/relationIndex`,
                              targetPath: `/draft/runtimeSemantics/visualContract/relations/${relation.relationIndex}`,
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
