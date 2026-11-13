/** 从独立分析的共同语义模型投影草稿，并展开确定性引用和推荐项代入。 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import {
    reviewAxes,
    type TemplateAnalysis,
    type TemplateCandidate,
    templateAnalysisSchema,
} from "./quality.js";
import type { TemplateDraft } from "./types.js";

import {
    globalFields as fields,
    resolveVisualFact,
    selectionFactRef as visualRef,
} from "./visual-facts.js";

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
type Axis = (typeof reviewAxes)[number];

// 新计划仅记录候选主轴；兼容旧计划显式声明的槽位并留给最终校验核对。
const coverage = shape.slotCoverageReview.valueType.extend({
    slotIds: shape.slotCoverageReview.valueType.shape.slotIds.optional(),
});
type Coverage = Record<Axis, z.infer<typeof coverage>>;

type SelectedCandidate = Pick<
    TemplateAnalysis["editableCandidates"][number],
    "axis" | "slotId"
>;

function selectedSlots(
    axis: Axis,
    candidates: readonly SelectedCandidate[],
): string[] {
    return [
        ...new Set(
            candidates.flatMap((item) =>
                item.axis === axis && item.slotId ? [item.slotId] : [],
            ),
        ),
    ];
}

export function projectSlotCoverage(
    coverage: Coverage,
    candidates: readonly SelectedCandidate[],
): TemplateAnalysis["slotCoverageReview"] {
    return Object.fromEntries(
        reviewAxes.map((axis) => [
            axis,
            {
                ...coverage[axis],
                slotIds:
                    coverage[axis].slotIds ?? selectedSlots(axis, candidates),
            },
        ]),
    ) as TemplateAnalysis["slotCoverageReview"];
}

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
                    .extend({
                        relationIndex: z.union([
                            z.int().min(0).max(63),
                            visualRef,
                        ]),
                    }),
            )
            .max(64),
        slotEvidence: z.record(z.string(), planSlot),
        componentGraph: z
            .array(shape.componentGraph.element.omit({ targetIds: true }))
            .min(1)
            .max(64),
        targetScopes: z
            .record(z.string(), z.array(z.string().min(1)).min(1).max(64))
            .describe(
                "键为每个 targetInstances[].id，值为一组 componentGraph[].id。每个正式目标恰好出现一次，组件 ID 不能作为键。",
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
    slotCoverageReview: z.record(shape.slotCoverageReview.keyType, coverage),
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
        const resolved = resolveVisualFact(
            ref,
            visual,
            draft.runtimeSemantics.targetInstances,
        );
        const fact = resolved.fact;
        if (fact === null)
            throw new TemplateProjectionError(value, [
                `${path}: 引用了不存在的 ${resolved.path}；修正引用或对应正式事实，不得猜测补文`,
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
            throw new TemplateProjectionError(
                value,
                [
                    `/analysis/targetScopes/${targetId}: 每个正式目标必须且只能引用一组已存在且不重复的组件`,
                ],
                [
                    {
                        path: "/analysis/targetScopes/*",
                        code: "invalid_target_scope",
                    },
                ],
            );
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
        slotCoverageReview: projectSlotCoverage(
            sourceAnalysis.slotCoverageReview,
            sourceAnalysis.editableCandidates,
        ),
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
                    typeof relationIndex === "number"
                        ? { field: "relations", index: relationIndex }
                        : relationIndex,
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
        if (fact === visual.medium)
            return { field: "medium" as const, index: null };
        for (const field of fields) {
            const index = visual[field].indexOf(fact);
            if (index >= 0) return { field, index };
        }
        if (draft.runtimeSemantics.version === 3) {
            for (const target of draft.runtimeSemantics.targetInstances) {
                for (const field of ["appearance", "pose"] as const) {
                    const index = target[field]?.indexOf(fact) ?? -1;
                    if (index >= 0)
                        return { targetId: target.id, field, index };
                }
            }
        }
        throw new TemplateContractError([
            "旧候选的分析事实没有准确对应正式约束，不能转换为字段引用",
        ]);
    };
    // 显式保留非一致旧声明，避免转换时掩盖重复或错误归属。
    const coverage = Object.fromEntries(
        reviewAxes.map((axis) => {
            const row = analysis.slotCoverageReview[axis];
            const { slotIds, ...observation } = row;
            return [
                axis,
                isDeepStrictEqual(
                    slotIds,
                    selectedSlots(axis, analysis.editableCandidates),
                )
                    ? observation
                    : row,
            ];
        }),
    );
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
            slotCoverageReview: coverage,
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
                    return {
                        ...relation,
                        relationIndex:
                            index >= 0 ? index : reference(runtimeFact),
                    };
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
