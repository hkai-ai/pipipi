/** 记录原始视觉依据的取舍及正式约束引用，只校验对账关系，不判断图像语义。 */
import { z } from "zod";
import type { TemplateAnalysis } from "./quality.js";
import type { TemplateDraft } from "./types.js";

export const visualSelectionsSchema = z
    .array(
        z.strictObject({
            evidenceIndex: z.int().min(0).max(63),
            decision: z.enum(["retain", "omit"]),
            reason: z.string().trim().min(1).max(500),
            factRefs: z
                .array(
                    z.strictObject({
                        field: z.enum([
                            "medium",
                            "styleTraits",
                            "composition",
                            "relations",
                            "colorAndLight",
                        ]),
                        index: z.int().min(0).max(63).nullable(),
                    }),
                )
                .max(16),
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
                              facts: selection.factRefs.map((ref) => ({
                                  path: `/analysis/semanticModel/runtimeSemantics/visualContract/${ref.field}${ref.index === null ? "" : `/${ref.index}`}`,
                                  fact:
                                      ref.field === "medium"
                                          ? ref.index === null
                                              ? visual.medium
                                              : null
                                          : ref.index === null
                                            ? null
                                            : (visual[ref.field][ref.index] ??
                                              null),
                              })),
                          },
                      ]
                    : [],
            ),
        }),
    );
}

export function visualSelectionIssues(
    analysis: SelectionAnalysis,
    visual: VisualContract,
): string[] {
    const issues: string[] = [];
    const selections = analysis.visualSelections;
    const observations = analysis.fieldEvidence.visualContract;
    if (
        selections.length !== observations.length ||
        new Set(selections.map((item) => item.evidenceIndex)).size !==
            observations.length ||
        selections.some((item) => item.evidenceIndex >= observations.length)
    )
        issues.push(
            "visualSelections: 每条原始视觉依据必须有且只有一个取舍决定",
        );
    for (const item of visualSelectionContext(analysis, visual)) {
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
    return [...new Set(issues)];
}
