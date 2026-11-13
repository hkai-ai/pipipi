/** 校验图片分析到正式草稿的对应关系，并验证独立复核的摘要与字段证据。 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
    observationShape,
    semanticEvidenceShape,
    slotEvidenceShape,
    sourceContractIssues,
    suggestionChecksShape,
    textRegionSchema,
} from "./analysis-contract.js";
import type { TemplateDraft } from "./types.js";
import { globalFields, targetFacts } from "./visual-facts.js";
import {
    visualSelectionIssues,
    visualSelectionsSchema,
} from "./visual-selection.js";

export const reviewAxes = [
    "subject",
    "text",
    "object",
    "clothing",
    "color",
    "prop",
    "scene",
    "nested_content",
] as const;
export { reviewChecks } from "../../process-runtime/template-diagnostics.js";

import { reviewChecks } from "../../process-runtime/template-diagnostics.js";

const visualFields = [
    "medium",
    "styleTraits",
    "composition",
    "relations",
    "colorAndLight",
] as const;
const featureAxes = [
    "identity",
    "body",
    "ageStage",
    "hair",
    "clothing",
    "accessories",
    "expression",
    "pose",
    "action",
] as const;
const gateNames = [
    "userMotivation",
    "independentUserChoice",
    "meaningfulVariation",
    "visuallyVisible",
    "modelControllable",
    "mechanismPreserved",
] as const;
const text = z.string().trim().min(1).max(1000);
const fact = z.string().trim().min(1).max(500);
const ids = z.array(z.string().min(1)).max(64);
const facts = z.array(fact).max(64);
const gate = z.strictObject({ passed: z.boolean(), evidence: text });
const coverage = z.strictObject({
    componentIds: ids,
    slotIds: ids,
    evidence: text,
});
const authority = z.strictObject({
    owner: z.enum(["source", "template"]),
    basis: z.enum([
        "identity_fidelity",
        "appearance_continuity",
        "core_mechanism",
        "composition_dependency",
        "explicit_transformation",
    ]),
    evidence: text,
    runtimeFact: fact.nullable(),
});
const namedRecord = <T extends string, S extends z.ZodType>(
    keys: readonly T[],
    value: S,
) => z.record(z.enum(keys), value);

export const templateAnalysisSchema = z.strictObject({
    ...observationShape,
    visualSelections: visualSelectionsSchema,
    templateValue: z.strictObject({
        whySelected: text,
        templateHook: text,
        fixedMechanism: facts.min(1),
        backendOnlyFacts: facts.min(1),
    }),
    playDecisionModel: z.strictObject({
        funProposition: text,
        userRecreationWish: text,
        coreUserDecisions: z
            .array(
                z.strictObject({
                    decisionId: z.string().min(1),
                    description: text,
                    slotId: z.string().min(1),
                    evidence: text,
                }),
            )
            .min(1)
            .max(4),
    }),
    componentGraph: z
        .array(
            z.strictObject({
                id: z.string().min(1),
                evidence: text,
                targetIds: ids,
                visualFields: z.array(z.enum(visualFields)).min(1),
            }),
        )
        .min(1)
        .max(64),
    identityTopology: z
        .array(
            z.strictObject({
                identityId: z.string().min(1),
                instanceIds: ids.min(1),
                componentIds: ids.min(1),
                targetIds: ids.min(1),
                evidence: text,
            }),
        )
        .max(32)
        .describe(
            "按原图识别同一身份及其实例。所有单元的 targetIds 合计必须恰好覆盖 runtimeSemantics.targetInstances 中 kind 不为 content_element 的目标 id，每个只出现一次。纯内容目标不建立身份单元，没有身份目标时返回空数组。instanceIds 和 componentIds 分别记录观察到的实例与组件，不能充当 targetIds。",
        ),
    textRegions: z.array(textRegionSchema).max(64),
    mediumComposition: z
        .strictObject({
            medium: fact,
            styleTraits: facts,
            composition: facts,
            colorAndLight: facts,
        })
        .describe(
            "已选定的稳定视觉规则；medium 与正式 visualContract.medium 逐字一致，三个数组的条目原样保留在正式同名字段；需要修改时同步修改两处，不用同义概括替代",
        ),
    spatialRelations: z
        .array(
            z.strictObject({
                componentIds: ids.min(1),
                evidence: text,
                runtimeFact: fact,
            }),
        )
        .max(64),
    slotCoverageReview: namedRecord(reviewAxes, coverage),
    editableCandidates: z
        .array(
            z.strictObject({
                componentId: z.string().min(1),
                axis: z.enum(reviewAxes),
                slotId: z.string().nullable(),
                evidence: text,
                gates: namedRecord(gateNames, gate),
            }),
        )
        .min(1)
        .max(64),
    slotEvidence: z.record(
        z.string(),
        z.strictObject({
            ...slotEvidenceShape,
            decisionId: z.string().min(1),
            componentIds: ids.min(1),
            defaultValue: fact,
            semanticAxis: fact,
            granularity: fact,
            selectionReason: z.enum([
                "identity_control",
                "template_hook",
                "high_value_text",
                "exact_content_asset",
            ]),
            openVisualFacts: facts
                .min(1)
                .describe(
                    "开放后不得被标题、标签和视觉合同锁回的具体事实；数组必须包含默认值和全部推荐值各自的精确原文，每项只填值本身，不加引号、默认主句、推荐主句、开放等说明。例如默认值为你好，则一项是你好，不能写默认文字你好开放。其他开放事实另列",
                ),
            imageRationale: text.nullable(),
            featureAuthority: namedRecord(featureAxes, authority).nullable(),
            identityRecognition: z
                .strictObject({
                    status: z.enum(["recognized", "unrecognized"]),
                    name: fact.nullable(),
                    evidence: text,
                })
                .nullable(),
            groupDecision: z
                .strictObject({
                    wholeGroupFidelity: z.boolean(),
                    naturalGroupPhoto: z.boolean(),
                    variableCount: z.boolean(),
                    sameKindMembers: z.boolean(),
                    noIndependentRoles: z.boolean(),
                    evidence: text,
                })
                .nullable(),
            substitutions: z
                .array(
                    z.strictObject({
                        ...suggestionChecksShape,
                        value: fact,
                        prompt: z.string().min(1).max(5000),
                        evidence: text,
                    }),
                )
                .length(3),
        }),
    ),
    titleEvidence: namedRecord(
        [
            "templateGrounded",
            "usageMotivation",
            "spokenNaturalness",
            "slotPortability",
            "userAppeal",
            "discoveryValue",
        ],
        gate,
    ),
    descriptionEvidence: namedRecord(
        [
            "userFacing",
            "complementsTitle",
            "spokenNaturalness",
            "slotPortability",
        ],
        gate,
    ),
    tagEvidence: z.record(
        z.string(),
        z.strictObject({
            visualEvidence: text,
            searchIntent: text,
            category: z.enum([
                "mechanism",
                "subject",
                "scene",
                "medium",
                "emotion",
                "use_case",
                "text",
                "relation",
            ]),
        }),
    ),
    semanticModel: z.strictObject({
        ...semanticEvidenceShape,
        promptTemplate: z.string().min(1),
        runtimeSemantics: z.unknown(),
    }),
});
export type TemplateAnalysis = z.infer<typeof templateAnalysisSchema>;
export type TemplateCandidate = {
    draft: TemplateDraft;
    analysis: TemplateAnalysis;
};

/** 比较两版候选的真实变更范围，数组作为整体字段复核。 */
export function candidateChanges(
    previous: unknown,
    current: unknown,
    path = "",
): string[] {
    if (isDeepStrictEqual(previous, current)) return [];
    if (
        previous &&
        current &&
        typeof previous === "object" &&
        typeof current === "object" &&
        !Array.isArray(previous) &&
        !Array.isArray(current)
    ) {
        const before = previous as Record<string, unknown>;
        const after = current as Record<string, unknown>;
        return [
            ...new Set([...Object.keys(before), ...Object.keys(after)]),
        ].flatMap((key) =>
            candidateChanges(
                before[key],
                after[key],
                `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
            ),
        );
    }
    return [path];
}
export const templateReviewSchema = z.strictObject({
    reviewedDraftSha256: z.string().regex(/^[a-f0-9]{64}$/),
    checks: namedRecord(
        reviewChecks,
        z.strictObject({
            passed: z.boolean(),
            evidence: z
                .array(
                    z.strictObject({
                        path: z.string().regex(/^\/(draft|analysis)\//),
                        observation: text,
                    }),
                )
                .min(1)
                .max(8),
        }),
    ),
    issues: z.array(text).max(19),
});

export function candidateDigest(candidate: TemplateCandidate): string {
    // 摘要由服务端计算；包含分析，避免复核草稿时分析被换掉。
    return createHash("sha256")
        .update(
            JSON.stringify(
                {
                    draft: candidate.draft,
                    analysis: candidate.analysis,
                },
                (_key, value: unknown) =>
                    value && typeof value === "object" && !Array.isArray(value)
                        ? Object.fromEntries(
                              Object.entries(value).sort(([a], [b]) =>
                                  a < b ? -1 : a > b ? 1 : 0,
                              ),
                          )
                        : value,
            ),
        )
        .digest("hex");
}
function sameValues(a: readonly string[], b: readonly string[]): boolean {
    return (
        a.length === b.length &&
        new Set(a).size === a.length &&
        a.every((value) => b.includes(value))
    );
}

/** 不依赖派生字段的检查先运行，避免引用错误掩盖其他可修正问题。 */
function visualFacts(runtime: TemplateDraft["runtimeSemantics"]): string[] {
    const visual = runtime.visualContract;
    return [
        visual.medium,
        ...globalFields.flatMap((field) => visual[field]),
        ...targetFacts(runtime),
    ];
}

export function missingComponentVisualFields(
    components: readonly { visualFields: readonly string[] }[],
) {
    return visualFields.filter(
        (field) =>
            !components.some((component) =>
                component.visualFields.includes(field),
            ),
    );
}

export function sourceAnalysisIssues(
    draft: TemplateDraft,
    analysis: {
        textRegions?: readonly Pick<
            z.infer<typeof textRegionSchema>,
            "id" | "action" | "exactText"
        >[];
        componentGraph: readonly {
            id: string;
            visualFields: readonly string[];
        }[];
        slotCoverageReview: Record<
            (typeof reviewAxes)[number],
            { componentIds: string[] }
        >;
        slotEvidence: Record<
            string,
            {
                featureAuthority: Record<
                    string,
                    Pick<z.infer<typeof authority>, "owner" | "basis">
                > | null;
            }
        >;
    },
    report?: (path: string, code: string) => void,
): string[] {
    const issues: string[] = [];
    for (const [index, component] of analysis.componentGraph.entries()) {
        if (
            !reviewAxes.some((axis) =>
                analysis.slotCoverageReview[axis].componentIds.includes(
                    component.id,
                ),
            )
        ) {
            report?.(`/analysis/componentGraph/${index}`, "coverage_mismatch");
            issues.push(`${component.id}: 组件遗漏八轴审查`);
        }
    }
    for (const field of missingComponentVisualFields(analysis.componentGraph)) {
        report?.(
            "/analysis/componentGraph/*/visualFields",
            "missing_visual_coverage",
        );
        issues.push(
            `组件分析必须覆盖五个视觉字段，缺少 ${field}；在有原图依据的组件 visualFields 中标出归属`,
        );
    }
    const runtime = draft.runtimeSemantics;
    const facts = visualFacts(runtime);
    for (const [index, region] of (analysis.textRegions ?? []).entries()) {
        const path = `/analysis/textRegions/${index}/exactText`;
        if (
            region.action === "preserve" &&
            !facts.some((fact) => fact.includes(region.exactText))
        ) {
            report?.(path, "fixed_text_missing");
            issues.push(
                `${region.id}: 固定文字必须逐字保留在视觉约束，不能只保留“标题”等摘要`,
            );
        }
        if (
            region.action === "free_editable" &&
            !draft.promptTemplate.includes(region.exactText)
        ) {
            report?.(path, "free_text_missing");
            issues.push(`${region.id}: 自由编辑文字必须保留在 Prompt`);
        }
        if (
            region.action === "remove" &&
            (facts.some((fact) => fact.includes(region.exactText)) ||
                draft.promptTemplate.includes(region.exactText))
        ) {
            report?.(path, "removed_text_retained");
            issues.push(`${region.id}: 删除文字仍出现在输出中`);
        }
    }
    for (const slot of draft.inputSchema.slots) {
        if (
            draft.runtimeSemantics.inputBindings[slot.id]?.operation !==
            "replace_identity"
        )
            continue;
        const features = analysis.slotEvidence[slot.id]?.featureAuthority;
        if (!features) continue;
        for (const axis of featureAxes) {
            const feature = features[axis];
            if (!feature) continue;
            const allowed =
                feature.owner === "template"
                    ? [
                          "core_mechanism",
                          "composition_dependency",
                          "explicit_transformation",
                      ]
                    : ["identity_fidelity", "appearance_continuity"];
            if (!allowed.includes(feature.basis)) {
                report?.(
                    `/analysis/slotEvidence/*/featureAuthority/${axis}/basis`,
                    "value_mismatch",
                );
                issues.push(`${slot.id}/${axis}: 特征权限依据不匹配`);
            }
        }
    }
    return issues;
}

export function analysisIssues(
    { draft, analysis: a }: TemplateCandidate,
    report?: (path: string, code: string) => void,
): string[] {
    const issues: string[] = [
        ...sourceAnalysisIssues(draft, a, report),
        ...sourceContractIssues({ draft, analysis: a }, report),
        ...visualSelectionIssues(
            a,
            draft.runtimeSemantics.visualContract,
            draft.runtimeSemantics.targetInstances,
            report,
        ),
    ].slice(0, 24);
    const check = (
        ok: boolean,
        path: string,
        code: string,
        message: string,
    ) => {
        if (!ok && issues.length < 24) {
            report?.(path, code);
            issues.push(message);
        }
    };
    const slots = draft.inputSchema.slots;
    const runtime = draft.runtimeSemantics;
    const visual = runtime.visualContract;
    if (runtime.version === 2)
        check(
            a.mediumComposition.styleTraits.length > 0 &&
                a.mediumComposition.composition.length > 0,
            "/analysis/mediumComposition",
            "missing_visual_coverage",
            "mediumComposition: v2 必须保留风格与构图事实",
        );
    const slotIds = slots.map((slot) => slot.id);
    const componentIds = a.componentGraph.map((item) => item.id);
    const targetIds = runtime.targetInstances.map((item) => item.id);
    const containsComponents = (values: readonly string[]) =>
        values.every((id) => componentIds.includes(id));
    const fixedText = JSON.stringify({
        targets:
            runtime.version === 3
                ? runtime.targetInstances.map(
                      ({ appearance: _appearance, ...target }) => target,
                  )
                : runtime.targetInstances,
        visual,
        title: draft.title,
        tags: draft.metadata.tags,
    });
    const facts = visualFacts(runtime);
    check(
        new Set(componentIds).size === componentIds.length,
        "/analysis/componentGraph",
        "duplicate_id",
        "analysis.componentGraph: 组件 ID 重复",
    );
    check(
        isDeepStrictEqual(
            {
                promptTemplate: a.semanticModel.promptTemplate,
                runtimeSemantics: a.semanticModel.runtimeSemantics,
            },
            {
                promptTemplate: draft.promptTemplate,
                runtimeSemantics: runtime,
            },
        ),
        "/analysis/semanticModel",
        "value_mismatch",
        "analysis.semanticModel 必须与最终 Prompt 和 runtimeSemantics 逐值一致",
    );
    check(
        sameValues(
            slotIds,
            a.playDecisionModel.coreUserDecisions.map((item) => item.slotId),
        ),
        "/analysis/playDecisionModel/coreUserDecisions",
        "coverage_mismatch",
        "每个核心控制必须一对一对应正式槽位",
    );
    const decisions = a.playDecisionModel.coreUserDecisions.map(
        (item) => item.decisionId,
    );
    check(
        new Set(decisions).size === decisions.length,
        "/analysis/playDecisionModel/coreUserDecisions/*/decisionId",
        "duplicate_id",
        "decisionId 不能重复",
    );
    check(
        sameValues(slotIds, Object.keys(a.slotEvidence)),
        "/analysis/slotEvidence",
        "coverage_mismatch",
        "slotEvidence 必须覆盖全部且仅有正式槽位",
    );
    check(
        sameValues(draft.metadata.tags, Object.keys(a.tagEvidence)),
        "/analysis/tagEvidence",
        "coverage_mismatch",
        "tagEvidence 必须覆盖最终每个标签",
    );
    const axisSlots = reviewAxes.flatMap(
        (axis) => a.slotCoverageReview[axis].slotIds,
    );
    check(
        sameValues(slotIds, axisSlots),
        "/analysis/slotCoverageReview",
        "coverage_mismatch",
        "八轴覆盖必须使每槽恰好归属一个主轴",
    );
    for (const axis of reviewAxes) {
        const coverage = a.slotCoverageReview[axis];
        check(
            containsComponents(coverage.componentIds),
            `/analysis/slotCoverageReview/${axis}/componentIds`,
            "missing_reference",
            `${axis}: 引用了不存在的组件`,
        );
        for (const candidate of a.editableCandidates.filter(
            (item) => item.axis === axis,
        )) {
            check(
                coverage.componentIds.includes(candidate.componentId),
                `/analysis/slotCoverageReview/${axis}/componentIds`,
                "coverage_mismatch",
                `${axis}: 候选组件遗漏覆盖`,
            );
            if (candidate.slotId)
                check(
                    coverage.slotIds.includes(candidate.slotId),
                    `/analysis/slotCoverageReview/${axis}/slotIds`,
                    "coverage_mismatch",
                    `${axis}: 候选槽位遗漏覆盖`,
                );
        }
    }
    for (const [index, component] of a.componentGraph.entries()) {
        check(
            component.targetIds.every((id) => targetIds.includes(id)),
            `/analysis/componentGraph/${index}/targetIds`,
            "missing_reference",
            `${component.id}: 引用未知目标`,
        );
    }
    check(
        targetIds.every((id) =>
            a.componentGraph.some((component) =>
                component.targetIds.includes(id),
            ),
        ),
        "/analysis/componentGraph/*/targetIds",
        "coverage_mismatch",
        "组件分析必须覆盖所有正式目标",
    );
    const identityTargets = runtime.targetInstances
        .filter((item) => item.kind !== "content_element")
        .map((item) => item.id);
    const topologyTargets = a.identityTopology.flatMap(
        (item) => item.targetIds,
    );
    check(
        sameValues(identityTargets, topologyTargets),
        "/analysis/identityTopology/*/targetIds",
        "coverage_mismatch",
        "身份拓扑必须覆盖每个身份目标且不重复",
    );
    check(
        new Set(a.identityTopology.map((item) => item.identityId)).size ===
            a.identityTopology.length,
        "/analysis/identityTopology/*/identityId",
        "duplicate_id",
        "身份单元 ID 不能重复",
    );
    for (const [index, identity] of a.identityTopology.entries())
        check(
            containsComponents(identity.componentIds),
            `/analysis/identityTopology/${index}/componentIds`,
            "missing_reference",
            "身份拓扑引用未知组件",
        );
    const selectedComponents = new Set<string>();
    const slotAxes = new Map<string, (typeof reviewAxes)[number]>();
    for (const [index, candidate] of a.editableCandidates.entries()) {
        check(
            componentIds.includes(candidate.componentId),
            `/analysis/editableCandidates/${index}/componentId`,
            "missing_reference",
            "候选项引用未知组件",
        );
        if (candidate.slotId) {
            const axis = slotAxes.get(candidate.slotId);
            check(
                !axis || axis === candidate.axis,
                `/analysis/editableCandidates/${index}/axis`,
                "coverage_mismatch",
                `${candidate.slotId}: 同一正式槽位的入选候选只能归属一个主轴，当前同时声明 ${axis} 与 ${candidate.axis}；核对原图后保留一个主轴，其余轴的关联组件可保留观察`,
            );
            slotAxes.set(candidate.slotId, candidate.axis);
            const selection = JSON.stringify([
                candidate.axis,
                candidate.componentId,
                candidate.slotId,
            ]);
            check(
                !selectedComponents.has(selection),
                `/analysis/editableCandidates/${index}/slotId`,
                "duplicate_id",
                `${candidate.slotId}: 同一组件在同一主轴重复入选同一槽位`,
            );
            selectedComponents.add(selection);
            check(
                slotIds.includes(candidate.slotId),
                `/analysis/editableCandidates/${index}/slotId`,
                "missing_reference",
                "候选项引用未知槽位",
            );
            check(
                gateNames.every((name) => candidate.gates[name].passed),
                `/analysis/editableCandidates/${index}/gates`,
                "analysis_gate_failed",
                `${candidate.slotId}: 入选候选必须通过六项门禁`,
            );
        }
    }
    check(
        a.mediumComposition.medium === visual.medium,
        "/analysis/mediumComposition/medium",
        "value_mismatch",
        "mediumComposition.medium 必须与正式媒介逐字一致",
    );
    for (const field of [
        "styleTraits",
        "composition",
        "colorAndLight",
    ] as const) {
        check(
            new Set(a.mediumComposition[field]).size ===
                a.mediumComposition[field].length,
            `/analysis/mediumComposition/${field}`,
            "duplicate_fact",
            `${field}: 选定事实不能重复`,
        );
        check(
            a.mediumComposition[field].every((fact) =>
                visual[field].includes(fact),
            ),
            `/analysis/mediumComposition/${field}`,
            "missing_reference",
            `${field}: 选定的视觉事实不得在正式字段中丢失或换字段`,
        );
    }
    for (const [index, relation] of a.spatialRelations.entries()) {
        check(
            containsComponents(relation.componentIds),
            `/analysis/spatialRelations/${index}/componentIds`,
            "missing_reference",
            `/analysis/spatialRelations/${index}/componentIds: 空间关系引用未知组件`,
        );
        check(
            [...visual.relations, ...targetFacts(runtime)].some((item) =>
                item.includes(relation.runtimeFact),
            ),
            `/analysis/spatialRelations/${index}/relationIndex`,
            "missing_reference",
            `/analysis/spatialRelations/${index}/runtimeFact -> /draft/runtimeSemantics/visualContract/relations: 空间关系必须逐项落实到 relations；修正对应来源事实或引用`,
        );
    }
    for (const [index, fact] of a.templateValue.backendOnlyFacts.entries())
        check(
            facts.some((value) => value.includes(fact)) &&
                !draft.promptTemplate.includes(fact),
            `/analysis/templateValue/backendFactRefs/${index}`,
            "backend_fact_exposure",
            "backendOnlyFacts 必须在视觉约束中落实且不进入前台 Prompt",
        );
    for (const slot of slots) {
        const evidence = a.slotEvidence[slot.id];
        if (!evidence) continue;
        const binding = runtime.inputBindings[slot.id];
        check(
            containsComponents(evidence.componentIds),
            "/analysis/slotEvidence/*/componentIds",
            "missing_reference",
            `${slot.id}: 槽位证据引用未知组件`,
        );
        check(
            a.playDecisionModel.coreUserDecisions.some(
                (item) =>
                    item.slotId === slot.id &&
                    item.decisionId === evidence.decisionId,
            ),
            "/analysis/slotEvidence/*/decisionId",
            "value_mismatch",
            `${slot.id}: 核心控制与槽位证据不对应`,
        );
        check(
            a.editableCandidates.some(
                (item) =>
                    item.slotId === slot.id &&
                    evidence.componentIds.includes(item.componentId),
            ),
            "/analysis/editableCandidates",
            "missing_selected_candidate",
            `${slot.id}: 正式槽位没有入选候选`,
        );
        check(
            evidence.defaultValue === slot.text.defaultValue,
            "/analysis/slotEvidence/*/defaultValue",
            "value_mismatch",
            `${slot.id}: 分析默认值与正式默认值不同`,
        );
        check(
            sameValues(
                slot.text.suggestions,
                evidence.substitutions.map((item) => item.value),
            ),
            "/analysis/slotEvidence/*/substitutions",
            "coverage_mismatch",
            `${slot.id}: 必须实际代入全部三个推荐项`,
        );
        const placeholder = [
            ...draft.promptTemplate.matchAll(
                /\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\|\s*("(?:[^"\\]|\\.)*")\s*\}\}/gu,
            ),
        ].find((item) => item[1] === slot.id)?.[0];
        for (const [index, substitution] of evidence.substitutions.entries())
            check(
                Boolean(placeholder) &&
                    substitution.prompt ===
                        draft.promptTemplate.replace(
                            placeholder ?? "",
                            () => substitution.value,
                        ),
                `/analysis/slotEvidence/*/substitutions/${index}/prompt`,
                "value_mismatch",
                `${slot.id}: substitutions.prompt 必须是真实替换本槽后的完整 Prompt`,
            );
        for (const [index, fact] of evidence.openVisualFacts.entries())
            check(
                !fixedText.includes(fact),
                `/analysis/slotEvidence/*/openVisualFacts/${index}`,
                "open_fact_frozen",
                `${slot.id}: 固定约束或发现文案锁回了开放事实`,
            );
        if (slot.image)
            check(
                Boolean(evidence.imageRationale),
                "/analysis/slotEvidence/*/imageRationale",
                "missing_evidence",
                `${slot.id}: 图片能力缺少素材映射依据`,
            );
        if (binding?.operation === "replace_identity") {
            check(
                Boolean(
                    evidence.featureAuthority &&
                        (binding.bindingPolicy === "preserve_group" ||
                            evidence.identityRecognition),
                ),
                "/analysis/slotEvidence/*/featureAuthority",
                "missing_evidence",
                `${slot.id}: 身份缺少识别或九轴特征权限`,
            );
            if (evidence.identityRecognition?.status === "recognized")
                check(
                    evidence.identityRecognition.name ===
                        slot.text.defaultValue,
                    "/analysis/slotEvidence/*/identityRecognition/name",
                    "value_mismatch",
                    `${slot.id}: 已识别身份必须作为默认值`,
                );
            if (evidence.featureAuthority) {
                check(
                    evidence.featureAuthority.clothing.owner ===
                        binding.clothingOwnership,
                    "/analysis/slotEvidence/*/featureAuthority/clothing/owner",
                    "value_mismatch",
                    `${slot.id}: 服装归属与分析冲突`,
                );
                check(
                    evidence.featureAuthority.identity.owner === "source",
                    "/analysis/slotEvidence/*/featureAuthority/identity/owner",
                    "value_mismatch",
                    `${slot.id}: 身份必须由输入接管`,
                );
                for (const axis of featureAxes) {
                    const { runtimeFact } = evidence.featureAuthority[axis];
                    check(
                        runtimeFact === null ||
                            facts.some((value) => value.includes(runtimeFact)),
                        `/analysis/slotEvidence/*/featureAuthority/${axis}/runtimeFactRef`,
                        "missing_reference",
                        `${slot.id}/${axis}: 特征执行事实必须落实到视觉约束，来源特征未额外声明时可为空`,
                    );
                }
            }
            if (binding.bindingPolicy === "preserve_group") {
                const group = evidence.groupDecision;
                check(
                    Boolean(
                        group?.wholeGroupFidelity &&
                            group.naturalGroupPhoto &&
                            group.variableCount &&
                            group.sameKindMembers &&
                            group.noIndependentRoles,
                    ),
                    "/analysis/slotEvidence/*/groupDecision",
                    "analysis_gate_failed",
                    `${slot.id}: 群组必须通过五项门禁`,
                );
            }
            const units = a.identityTopology.filter((unit) =>
                unit.targetIds.some((id) => binding.targetIds.includes(id)),
            );
            check(
                units.length === 1 &&
                    sameValues(units[0].targetIds, binding.targetIds),
                "/analysis/identityTopology",
                "target_binding_mismatch",
                `${slot.id}: 独立身份和重复实例必须对应同一身份单元`,
            );
        }
    }
    const unitRoutes = new Map<string, string>();
    check(
        new Set(a.textRegions.map((region) => region.id)).size ===
            a.textRegions.length,
        "/analysis/textRegions/*/id",
        "duplicate_id",
        "文字区域 ID 不能重复",
    );
    for (const [index, region] of a.textRegions.entries()) {
        check(
            componentIds.includes(region.componentId),
            `/analysis/textRegions/${index}/componentId`,
            "missing_reference",
            `${region.id}: 文字区域引用未知组件`,
        );
        const route = JSON.stringify([
            region.action,
            region.slotId,
            region.semanticUnitRole,
        ]);
        check(
            !unitRoutes.has(region.semanticUnitId) ||
                unitRoutes.get(region.semanticUnitId) === route,
            `/analysis/textRegions/${index}/semanticUnitId`,
            "route_mismatch",
            `${region.id}: 同一语义单元必须使用同一路由`,
        );
        unitRoutes.set(region.semanticUnitId, route);
        check(
            region.action !== "review",
            `/analysis/textRegions/${index}/action`,
            "unresolved_text",
            `${region.id}: 未解决的文字识别必须阻断交付`,
        );
        if (region.action === "open_slot")
            check(
                slotIds.includes(region.slotId ?? ""),
                `/analysis/textRegions/${index}/slotId`,
                "missing_reference",
                `${region.id}: 文字引用未知槽位`,
            );
        else
            check(
                region.slotId === null,
                `/analysis/textRegions/${index}/slotId`,
                "unexpected_binding",
                `${region.id}: 非槽位文字不能绑定槽位`,
            );
    }
    return issues;
}

export function reviewIssues(
    candidate: TemplateCandidate,
    value: unknown,
    report?: (path: string, code: string) => void,
): string[] {
    const parsed = templateReviewSchema.safeParse(value);
    if (!parsed.success) {
        report?.("/review", "invalid_schema");
        return ["review 必须包含准确摘要、十九项复核及字段引用"];
    }
    const review = parsed.data;
    const issues: string[] = [];
    if (review.reviewedDraftSha256 !== candidateDigest(candidate)) {
        report?.("/review/reviewedDraftSha256", "digest_mismatch");
        issues.push("review 摘要与本次最终候选不符");
    }
    if (review.issues.length) {
        report?.("/review/issues", "unresolved_review");
        issues.push(...review.issues.map((issue) => `review.issues: ${issue}`));
    }
    function evidenceIssue(
        name: (typeof reviewChecks)[number],
        message: string,
    ) {
        report?.(`/review/checks/${name}/evidence`, "review_evidence");
        issues.push(message);
    }
    const observations = new Set<string>();
    for (const path of [
        "/analysis/fieldEvidence/visualContract",
        "/analysis/visualSelections",
        "/analysis/semanticModel/runtimeSemantics/visualContract",
    ]) {
        if (
            !review.checks.visualContractRespectsInputs.evidence.some(
                (item) =>
                    item.path === path || item.path.startsWith(`${path}/`),
            )
        )
            evidenceIssue(
                "visualContractRespectsInputs",
                `review.visualContractRespectsInputs: 缺少 ${path} 的观察、取舍或约束复核`,
            );
    }
    if (
        candidate.draft.runtimeSemantics.version === 3 &&
        !review.checks.visualContractRespectsInputs.evidence.some((item) =>
            item.path.startsWith(
                "/analysis/semanticModel/runtimeSemantics/targetInstances",
            ),
        )
    )
        evidenceIssue(
            "visualContractRespectsInputs",
            "review.visualContractRespectsInputs: 缺少目标外观与姿势归属复核",
        );
    if (candidate.analysis.textRegions.length > 0) {
        const evidence = review.checks.textEditLayersComplete.evidence;
        for (const path of [
            "/analysis/textRegions",
            "/draft/runtimeSemantics/visualContract",
        ]) {
            if (
                !evidence.some(
                    (item) =>
                        item.path === path ||
                        item.path.startsWith(`${path}/`) ||
                        (path === "/draft/runtimeSemantics/visualContract" &&
                            item.path.startsWith(
                                "/analysis/semanticModel/runtimeSemantics/visualContract",
                            )),
                )
            )
                evidenceIssue(
                    "textEditLayersComplete",
                    `review.textEditLayersComplete: 缺少 ${path} 的独立文字排版观察`,
                );
        }
    }
    for (const name of reviewChecks) {
        const item = review.checks[name];
        if (!item.passed) {
            report?.(`/review/checks/${name}/passed`, "check_failed");
            issues.push(`review.${name} 未通过`);
        }
        for (const evidence of item.evidence) {
            if (!resolvePointer(candidate, evidence.path)) {
                report?.(
                    `/review/checks/${name}/evidence`,
                    "missing_reference",
                );
                issues.push(`review.${name}: 引用不存在 ${evidence.path}`);
            }
        }
        const observation = item.evidence
            .map((evidence) => evidence.observation)
            .join("\n");
        if (observations.has(observation))
            evidenceIssue(name, `review.${name}: 不得用重复套话代替逐项复核`);
        observations.add(observation);
    }
    for (const axis of reviewAxes) {
        const path = `/analysis/slotCoverageReview/${axis}`;
        if (
            !parsed.data.checks.slotRecallComplete.evidence.some(
                (item) =>
                    item.path === path || item.path.startsWith(`${path}/`),
            )
        )
            evidenceIssue(
                "slotRecallComplete",
                `review.slotRecallComplete: 缺少 ${path} 的独立观察与取舍依据`,
            );
    }
    return issues.slice(0, 24);
}
function resolvePointer(root: unknown, pointer: string): boolean {
    let value = root;
    for (const part of pointer.slice(1).split("/")) {
        const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
            return false;
        value = (value as Record<string, unknown>)[key];
    }
    // Schema 允许的 null、false 或空集合可证明能力未启用；存在性不能替代语义判断。
    return value !== undefined;
}
