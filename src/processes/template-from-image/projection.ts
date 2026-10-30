/** 从独立分析的共同语义模型投影草稿，并展开确定性引用和推荐项代入。 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
    readTemplateCandidate,
    readTemplateDraft,
    TemplateContractError,
} from "./contract.js";
import {
    type TemplateValidationDiagnostic,
    validationDiagnostics,
} from "./diagnostics.js";
import { type TemplateCandidate, templateAnalysisSchema } from "./quality.js";
import type { TemplateDraft } from "./types.js";

const fields = [
    "styleTraits",
    "composition",
    "relations",
    "colorAndLight",
] as const;
const visualRef = z.strictObject({
    field: z.enum(fields),
    index: z.int().min(0).max(63),
});
const shape = templateAnalysisSchema.shape;
const slot = shape.slotEvidence.valueType;
const authority = slot.shape.featureAuthority.unwrap();
const planSlot = slot
    .omit({
        defaultValue: true,
        substitutions: true,
        featureAuthority: true,
        componentIds: true,
    })
    .extend({
        substitutions: z
            .array(slot.shape.substitutions.element.omit({ prompt: true }))
            .length(3),
        featureAuthority: z
            .record(
                authority.keyType,
                authority.valueType
                    .omit({ runtimeFact: true })
                    .extend({ runtimeFactRef: visualRef.nullable() }),
            )
            .nullable()
            .describe(
                "仅 replace_identity 槽位填写完整九轴具名权限；其他槽位为 null",
            ),
    });
const planAnalysis = templateAnalysisSchema
    .omit({
        templateValue: true,
        spatialRelations: true,
        slotEvidence: true,
        componentGraph: true,
    })
    .extend({
        templateValue: shape.templateValue
            .omit({ backendOnlyFacts: true })
            .extend({ backendFactRefs: z.array(visualRef).min(1).max(64) }),
        spatialRelations: z
            .array(
                shape.spatialRelations.element
                    .omit({ runtimeFact: true })
                    .extend({ relationIndex: z.int().min(0).max(63) }),
            )
            .max(64),
        slotEvidence: z.record(z.string(), planSlot),
        componentGraph: z
            .array(shape.componentGraph.element.omit({ targetIds: true }))
            .min(1)
            .max(64),
        targetScopes: z.record(
            z.string(),
            z.array(z.string().min(1)).min(1).max(64),
        ),
    });
// 字段映射不能把玩法和组件分析挪到最后，模型请求仍遵循来源的分析顺序。
export const templatePlanAnalysisSchema = z.strictObject({
    imageObservation: planAnalysis.shape.imageObservation,
    visualMechanism: planAnalysis.shape.visualMechanism,
    templateValue: planAnalysis.shape.templateValue,
    playDecisionModel: planAnalysis.shape.playDecisionModel,
    componentGraph: planAnalysis.shape.componentGraph,
    identityTopology: planAnalysis.shape.identityTopology,
    textRegions: planAnalysis.shape.textRegions,
    fieldEvidence: planAnalysis.shape.fieldEvidence,
    visualSelections: planAnalysis.shape.visualSelections,
    mediumComposition: planAnalysis.shape.mediumComposition,
    spatialRelations: planAnalysis.shape.spatialRelations,
    targetScopes: planAnalysis.shape.targetScopes,
    slotCoverageReview: planAnalysis.shape.slotCoverageReview,
    editableCandidates: planAnalysis.shape.editableCandidates,
    slotEvidence: planAnalysis.shape.slotEvidence,
    titleEvidence: planAnalysis.shape.titleEvidence,
    descriptionEvidence: planAnalysis.shape.descriptionEvidence,
    tagEvidence: planAnalysis.shape.tagEvidence,
    containers: planAnalysis.shape.containers,
    fixedStructure: planAnalysis.shape.fixedStructure,
    promptCoverage: planAnalysis.shape.promptCoverage,
    translationEquivalences: z.array(
        shape.translationEquivalences.element.omit({
            sourceTextSha256: true,
            targetTextSha256: true,
        }),
    ),
    warnings: planAnalysis.shape.warnings,
    semanticModel: planAnalysis.shape.semanticModel,
});
export const templatePlanSchema = z.strictObject({
    analysis: templatePlanAnalysisSchema,
    draft: z.unknown(),
});

export class TemplateProjectionError extends TemplateContractError {
    constructor(
        readonly previous: unknown,
        issues: readonly string[],
        diagnostics?: readonly TemplateValidationDiagnostic[],
    ) {
        super(issues, diagnostics);
        this.message = issues.join("; ");
    }
}

export function readTemplatePlan(value: unknown) {
    const parsed = templatePlanSchema.safeParse(value);
    if (!parsed.success)
        throw new TemplateProjectionError(
            value,
            parsed.error.issues
                .slice(0, 16)
                .map((issue) => `/${issue.path.join("/")}: ${issue.message}`),
            validationDiagnostics(parsed.error.issues),
        );
    try {
        const metadata = parsed.data.draft;
        if (
            !metadata ||
            typeof metadata !== "object" ||
            "promptTemplate" in metadata ||
            "runtimeSemantics" in metadata
        )
            throw new TemplateContractError([
                "draft 只包含发现文案与输入配置；Prompt 和运行语义只在 analysis.semanticModel 声明",
            ]);
        const draft = readTemplateDraft({
            ...metadata,
            promptTemplate: parsed.data.analysis.semanticModel.promptTemplate,
            runtimeSemantics:
                parsed.data.analysis.semanticModel.runtimeSemantics,
        });
        const { promptTemplate, runtimeSemantics, ...fields } = draft;
        return {
            analysis: {
                ...parsed.data.analysis,
                semanticModel: {
                    ...parsed.data.analysis.semanticModel,
                    promptTemplate,
                    runtimeSemantics,
                },
            },
            draft: fields,
        };
    } catch (error) {
        if (error instanceof TemplateContractError)
            throw new TemplateProjectionError(
                value,
                error.issues,
                error.diagnostics,
            );
        throw error;
    }
}

export function draftFromPlan(
    plan: ReturnType<typeof readTemplatePlan>,
): TemplateDraft {
    return {
        ...plan.draft,
        promptTemplate: plan.analysis.semanticModel.promptTemplate,
        runtimeSemantics: plan.analysis.semanticModel.runtimeSemantics,
    };
}

export function materializeTemplatePlan(value: unknown): TemplateCandidate {
    const plan = readTemplatePlan(value);
    const draft = draftFromPlan(plan);
    const visual = draft.runtimeSemantics.visualContract;
    const resolve = (ref: z.infer<typeof visualRef>, path: string): string => {
        const fact = visual[ref.field][ref.index];
        if (fact === undefined)
            throw new TemplateProjectionError(value, [
                `${path}: 引用了不存在的 /draft/runtimeSemantics/visualContract/${ref.field}/${ref.index}；有效索引为 0..${visual[ref.field].length - 1}，修正引用或对应正式事实，不得猜测补文`,
            ]);
        return fact;
    };
    const { backendFactRefs, ...templateValue } = plan.analysis.templateValue;
    const { targetScopes, ...sourceAnalysis } = plan.analysis;
    const targetIds = draft.runtimeSemantics.targetInstances.map(
        (target) => target.id,
    );
    const componentIds = sourceAnalysis.componentGraph.map(
        (component) => component.id,
    );
    for (const targetId of new Set([
        ...targetIds,
        ...Object.keys(targetScopes),
    ])) {
        const scope = targetScopes[targetId];
        if (
            !targetIds.includes(targetId) ||
            !scope ||
            new Set(scope).size !== scope.length ||
            scope.some((id) => !componentIds.includes(id))
        )
            throw new TemplateProjectionError(value, [
                `/analysis/targetScopes/${targetId}: 每个正式目标必须且只能引用一组已存在且不重复的组件`,
            ]);
    }
    const sha = (text: string) =>
        createHash("sha256").update(text).digest("hex");
    const regionText = (id: string) => {
        const region = sourceAnalysis.textRegions.find(
            (region) => region.id === id,
        );
        if (!region)
            throw new TemplateProjectionError(value, [
                "translationEquivalences: 引用未知文字区",
            ]);
        return region.exactText;
    };
    const analysis = {
        ...sourceAnalysis,
        translationEquivalences: sourceAnalysis.translationEquivalences.map(
            (entry) => ({
                ...entry,
                sourceTextSha256: sha(regionText(entry.sourceRegionId)),
                targetTextSha256: Object.fromEntries(
                    entry.targetRegionIds.map((id) => [
                        id,
                        sha(regionText(id)),
                    ]),
                ),
            }),
        ),
        componentGraph: sourceAnalysis.componentGraph.map((component) => ({
            ...component,
            targetIds: targetIds.filter((id) =>
                targetScopes[id].includes(component.id),
            ),
        })),
        templateValue: {
            ...templateValue,
            backendOnlyFacts: backendFactRefs.map((ref, i) =>
                resolve(ref, `/analysis/templateValue/backendFactRefs/${i}`),
            ),
        },

        spatialRelations: plan.analysis.spatialRelations.map(
            ({ relationIndex, ...relation }, i) => ({
                ...relation,
                runtimeFact: resolve(
                    { field: "relations", index: relationIndex },
                    `/analysis/spatialRelations/${i}/relationIndex`,
                ),
            }),
        ),
        slotEvidence: Object.fromEntries(
            Object.entries(plan.analysis.slotEvidence).map(([id, evidence]) => {
                const input = draft.inputSchema.slots.find(
                    (slot) => slot.id === id,
                );
                if (!input)
                    throw new TemplateProjectionError(value, [
                        `/analysis/slotEvidence/${id}: /draft/inputSchema/slots 中不存在对应槽位`,
                    ]);
                const placeholders = [
                    ...draft.promptTemplate.matchAll(
                        /\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\|\s*("(?:[^"\\]|\\.)*")\s*\}\}/gu,
                    ),
                ].filter((match) => match[1] === id);
                if (placeholders.length !== 1)
                    throw new TemplateProjectionError(value, [
                        `/draft/promptTemplate: 槽位 ${id} 期望一个占位符，实际为 ${placeholders.length} 个`,
                    ]);
                return [
                    id,
                    {
                        ...evidence,
                        componentIds: [
                            ...new Set(
                                (
                                    draft.runtimeSemantics.inputBindings[id]
                                        ?.targetIds ?? []
                                ).flatMap(
                                    (target) => targetScopes[target] ?? [],
                                ),
                            ),
                        ],
                        defaultValue: input.text.defaultValue,
                        substitutions: evidence.substitutions.map((item) => ({
                            ...item,
                            prompt: draft.promptTemplate.replace(
                                placeholders[0][0],
                                () => item.value,
                            ),
                        })),
                        featureAuthority:
                            evidence.featureAuthority === null
                                ? null
                                : Object.fromEntries(
                                      Object.entries(
                                          evidence.featureAuthority,
                                      ).map(
                                          ([
                                              axis,
                                              { runtimeFactRef, ...feature },
                                          ]) => [
                                              axis,
                                              {
                                                  ...feature,
                                                  runtimeFact:
                                                      runtimeFactRef === null
                                                          ? null
                                                          : resolve(
                                                                runtimeFactRef,
                                                                `/analysis/slotEvidence/${id}/featureAuthority/${axis}/runtimeFactRef`,
                                                            ),
                                              },
                                          ],
                                      ),
                                  ),
                    },
                ];
            }),
        ),
    };
    // 副本不共享可变对象，复核摘要始终绑定投影后的最终候选。
    try {
        return readTemplateCandidate(structuredClone({ draft, analysis }));
    } catch (error) {
        if (error instanceof TemplateContractError)
            throw new TemplateProjectionError(value, error.issues);
        throw error;
    }
}

export function toTemplatePlan(candidate: TemplateCandidate) {
    const { draft, analysis } = structuredClone(candidate);
    const visual = draft.runtimeSemantics.visualContract;
    const reference = (fact: string) => {
        for (const field of fields) {
            const index = visual[field].indexOf(fact);
            if (index >= 0) return { field, index };
        }
        throw new TemplateContractError([
            "旧候选的分析事实没有准确对应正式约束，不能转换为字段引用",
        ]);
    };
    const rest = analysis;
    const { backendOnlyFacts, ...templateValue } = rest.templateValue;
    const {
        promptTemplate: _prompt,
        runtimeSemantics: _runtime,
        ...metadata
    } = draft;
    return readTemplatePlan({
        draft: metadata,
        analysis: {
            ...rest,
            translationEquivalences: rest.translationEquivalences.map(
                ({ sourceRegionId, targetRegionIds }) => ({
                    sourceRegionId,
                    targetRegionIds,
                }),
            ),
            componentGraph: rest.componentGraph.map(
                ({ targetIds: _targets, ...component }) => component,
            ),
            targetScopes: Object.fromEntries(
                draft.runtimeSemantics.targetInstances.map((target) => [
                    target.id,
                    rest.componentGraph
                        .filter((component) =>
                            component.targetIds.includes(target.id),
                        )
                        .map((component) => component.id),
                ]),
            ),
            templateValue: {
                ...templateValue,
                backendFactRefs: backendOnlyFacts.map(reference),
            },
            spatialRelations: rest.spatialRelations.map(
                ({ runtimeFact, ...relation }) => {
                    const index = visual.relations.indexOf(runtimeFact);
                    if (index < 0)
                        throw new TemplateContractError([
                            "旧候选空间事实没有准确对应 relations，不能转换为字段引用",
                        ]);
                    return { ...relation, relationIndex: index };
                },
            ),
            slotEvidence: Object.fromEntries(
                Object.entries(rest.slotEvidence).map(
                    ([
                        id,
                        {
                            defaultValue: _default,
                            componentIds: _components,
                            ...evidence
                        },
                    ]) => [
                        id,
                        {
                            ...evidence,
                            substitutions: evidence.substitutions.map(
                                ({ prompt: _prompt, ...item }) => item,
                            ),
                            featureAuthority:
                                evidence.featureAuthority === null
                                    ? null
                                    : Object.fromEntries(
                                          Object.entries(
                                              evidence.featureAuthority,
                                          ).map(
                                              ([
                                                  axis,
                                                  { runtimeFact, ...feature },
                                              ]) => [
                                                  axis,
                                                  {
                                                      ...feature,
                                                      runtimeFactRef:
                                                          runtimeFact === null
                                                              ? null
                                                              : reference(
                                                                    runtimeFact,
                                                                ),
                                                  },
                                              ],
                                          ),
                                      ),
                        },
                    ],
                ),
            ),
        },
    });
}
