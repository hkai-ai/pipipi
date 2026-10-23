/** 记录原始视觉依据的取舍及正式约束引用，只校验对账关系，不判断图像语义。 */
import { z } from "zod";
import type { TemplateAnalysis } from "./quality.js";
import type { TemplateDraft } from "./types.js";
import { resolveVisualFact, selectionFactRef } from "./visual-facts.js";

export const visualSelectionsSchema = z
    .array(
        z.strictObject({
            evidenceIndex: z.int().min(0).max(63),
            decision: z.enum(["retain", "omit"]),
            reason: z.string().trim().min(1).max(500),
            factRefs: z.array(selectionFactRef).max(16),
        }),
    )
    .min(1)
    .max(64)
    .describe(
        "逐项对账 fieldEvidence.visualContract 的原始依据：retain 说明为何影响重制效果并引用正式约束；omit 说明为何可舍弃或随输入变化且 factRefs 为空。medium 的 index 为 null，其他字段用数组索引。不复制观察或执行句，不预设图像特征",
    );

type SelectionAnalysis = Pick<
    TemplateAnalysis,
    "fieldEvidence" | "visualSelections"
>;
type VisualContract = TemplateDraft["runtimeSemantics"]["visualContract"];

export function visualSelectionContext(
    analysis: SelectionAnalysis,
    visual: VisualContract,
    targets: TemplateDraft["runtimeSemantics"]["targetInstances"] = [],
) {
    return analysis.fieldEvidence.visualContract.map(
        (observation, evidenceIndex) => ({
            observationPath: `/analysis/fieldEvidence/visualContract/${evidenceIndex}`,
            observation,
            decisions: analysis.visualSelections.flatMap((selection, index) =>
                selection.evidenceIndex === evidenceIndex
                    ? [
                          {
                              path: `/analysis/visualSelections/${index}`,
                              decision: selection.decision,
                              reason: selection.reason,
                              facts: selection.factRefs.map((ref) =>
                                  resolveVisualFact(ref, visual, targets),
                              ),
                          },
                      ]
                    : [],
            ),
        }),
    );
}

/** 为独立复核定位缺失观察引用的准确事实，不推测或自动补齐。 */
export function unreferencedTargetFacts(
    analysis: SelectionAnalysis,
    targets: TemplateDraft["runtimeSemantics"]["targetInstances"],
) {
    return targets.flatMap((target, targetIndex) =>
        (["appearance", "pose"] as const).flatMap((field) =>
            (target[field] ?? []).flatMap((fact, index) =>
                analysis.visualSelections.some(
                    (selection) =>
                        selection.decision === "retain" &&
                        selection.factRefs.some(
                            (ref) =>
                                "targetId" in ref &&
                                ref.targetId === target.id &&
                                ref.field === field &&
                                ref.index === index,
                        ),
                )
                    ? []
                    : [
                          {
                              path: `/analysis/semanticModel/runtimeSemantics/targetInstances/${targetIndex}/${field}/${index}`,
                              fact,
                              requiredRef: {
                                  targetId: target.id,
                                  field,
                                  index,
                              },
                          },
                      ],
            ),
        ),
    );
}

export function visualSelectionIssues(
    analysis: SelectionAnalysis,
    visual: VisualContract,
    targets: TemplateDraft["runtimeSemantics"]["targetInstances"] = [],
): string[] {
    const issues: string[] = [];
    const selections = analysis.visualSelections;
    const observations = analysis.fieldEvidence.visualContract;
    // 一条观察可支持多个不同事实；只在 v3 目标事实存在时接受分组引用，不改写候选或摘要。
    const groupedFacts = targets.some(
        (target) =>
            target.appearance !== undefined || target.pose !== undefined,
    );
    const coverageInvalid =
        new Set(selections.map((item) => item.evidenceIndex)).size !==
            observations.length ||
        selections.some((item) => item.evidenceIndex >= observations.length);
    const decisionsInvalid = observations.some((_, index) => {
        const rows = selections.filter((item) => item.evidenceIndex === index);
        if (rows.length <= 1) return false;
        if (!groupedFacts || rows.some((item) => item.decision !== "retain"))
            return true;
        const refs = rows.flatMap((item) =>
            item.factRefs.map((ref) =>
                JSON.stringify([
                    "targetId" in ref ? ref.targetId : null,
                    ref.field,
                    ref.index,
                ]),
            ),
        );
        return new Set(refs).size !== refs.length;
    });
    if (coverageInvalid || decisionsInvalid)
        issues.push(
            "visualSelections: 每条原始视觉依据必须有且只有一个取舍决定；分组保留不能重复引用事实",
        );
    for (const item of visualSelectionContext(analysis, visual, targets)) {
        for (const selection of item.decisions) {
            if (
                selection.decision === "retain" &&
                (!selection.facts.length ||
                    selection.facts.some((ref) => ref.fact === null))
            )
                issues.push(
                    "visualSelections.factRefs: 保留项必须引用存在的正式视觉约束",
                );
            if (selection.decision === "omit" && selection.facts.length)
                issues.push(
                    "visualSelections.factRefs: 舍弃项不得同时声明冻结约束",
                );
        }
    }
    for (const target of targets) {
        for (const field of ["appearance", "pose"] as const) {
            for (const fact of target[field] ?? []) {
                const globalFacts = [
                    visual.medium,
                    ...visual.styleTraits,
                    ...visual.composition,
                    ...visual.relations,
                    ...visual.colorAndLight,
                ];
                if (
                    globalFacts.includes(fact) ||
                    (field === "appearance" && target.pose?.includes(fact))
                )
                    issues.push(
                        "visualSelections: 目标事实不得重复冻结到全局或另一类归属",
                    );
            }
        }
    }
    if (unreferencedTargetFacts(analysis, targets).length)
        issues.push("visualSelections: 每条目标事实必须有原始观察及保留引用");
    return [...new Set(issues)];
}
