/** 为模型修正提供具体字段差异与特征约束，不写入日志或公开响应。 */
import { readTemplateCandidate, TemplateContractError } from "./contract.js";

export function templateRepairContext(value: unknown) {
    try {
        const candidate = readTemplateCandidate(value);
        const { draft, analysis } = candidate;
        return {
            unresolvedRelations: analysis.spatialRelations.flatMap(
                (relation, index) =>
                    draft.runtimeSemantics.visualContract.relations.some(
                        (text) => text.includes(relation.runtimeFact),
                    )
                        ? []
                        : [
                              {
                                  path: `/analysis/spatialRelations/${index}/runtimeFact`,
                                  targetPath:
                                      "/draft/runtimeSemantics/visualContract/relations",
                                  expected: relation.runtimeFact,
                                  actual: draft.runtimeSemantics.visualContract
                                      .relations,
                              },
                          ],
            ),
            slotConstraints: draft.inputSchema.slots.map((slot, index) => ({
                slotId: slot.id,
                path: `/draft/inputSchema/slots/${index}/text/suggestions`,
                defaultValue: slot.text.defaultValue,
                suggestions: slot.text.suggestions,
                featurePath: `/analysis/slotEvidence/${slot.id}/featureAuthority`,
                templateOwnedFeatures: Object.entries(
                    analysis.slotEvidence[slot.id]?.featureAuthority ?? {},
                )
                    .filter(([, feature]) => feature.owner === "template")
                    .map(([axis, feature]) => ({
                        axis,
                        basis: feature.basis,
                        runtimeFact: feature.runtimeFact,
                    })),
                openVisualFacts:
                    analysis.slotEvidence[slot.id]?.openVisualFacts ?? [],
            })),
        };
    } catch (error) {
        if (error instanceof TemplateContractError) return null;
        throw error;
    }
}
