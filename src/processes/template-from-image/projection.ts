/** 将模型的事实引用投影为完整候选，程序维护语义副本和推荐项代入。 */
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
export const templatePlanAnalysisSchema = templateAnalysisSchema
    .omit({
        semanticModel: true,
        mediumComposition: true,
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
export const templatePlanSchema = z.strictObject({
    draft: z.unknown(),
    analysis: templatePlanAnalysisSchema,
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
        return {
            analysis: parsed.data.analysis,
            draft: readTemplateDraft(parsed.data.draft),
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

export function materializeTemplatePlan(value: unknown): TemplateCandidate {
    const plan = readTemplatePlan(value);
    const { draft } = plan;
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
    const analysis = {
        ...sourceAnalysis,
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
        mediumComposition: {
            medium: visual.medium,
            styleTraits: visual.styleTraits,
            composition: visual.composition,
            colorAndLight: visual.colorAndLight,
        },
        semanticModel: {
            promptTemplate: draft.promptTemplate,
            runtimeSemantics: draft.runtimeSemantics,
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
    const {
        semanticModel: _semantic,
        mediumComposition: _medium,
        ...rest
    } = analysis;
    const { backendOnlyFacts, ...templateValue } = rest.templateValue;
    return readTemplatePlan({
        draft,
        analysis: {
            ...rest,
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
