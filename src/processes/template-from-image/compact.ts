/** 将模型的紧凑分析和复核无损还原为原校验合同，不推断或补填结论。 */
import { z } from "zod";
import { TemplateContractError } from "./contract.js";
import { templateCorrectionPaths } from "./correction.js";
import { validationDiagnostics } from "./diagnostics.js";
import { templateInspectionSchema } from "./inspection.js";
import {
    TemplateProjectionError,
    templatePlanAnalysisSchema,
} from "./projection.js";
import { reviewAxes, reviewChecks, templateAnalysisSchema } from "./quality.js";

const shape = templatePlanAnalysisSchema.shape;
const candidate = shape.editableCandidates.element;
const gateNames = [
    "userMotivation",
    "independentUserChoice",
    "meaningfulVariation",
    "visuallyVisible",
    "modelControllable",
    "mechanismPreserved",
] as const;
const brief = z.string().trim().min(1).max(96);
const slot = shape.slotEvidence.valueType;
const authority = slot.shape.featureAuthority.unwrap().valueType;
const component = shape.componentGraph.element.shape;
const relation = shape.spatialRelations.element.shape;
const coverage = shape.slotCoverageReview.valueType.shape;
const tag = shape.tagEvidence.valueType.shape;

const compactFields = templatePlanAnalysisSchema.extend({
    componentGraph: z
        .array(z.tuple([component.id, brief, component.visualFields]))
        .min(1)
        .max(64)
        .describe("每行 [id, 图像证据, visualFields]"),
    spatialRelations: z
        .array(z.tuple([relation.componentIds, brief, relation.relationIndex]))
        .max(64)
        .describe("每行 [componentIds, 图像证据, relationIndex]"),
    slotCoverageReview: z
        .record(
            shape.slotCoverageReview.keyType,
            z.tuple([coverage.componentIds, coverage.slotIds, brief]),
        )
        .describe("八轴各为 [componentIds, slotIds, 图像取舍证据]"),
    editableCandidates: z
        .array(
            candidate.extend({
                evidence: brief,
                gates: z
                    .array(z.tuple([z.boolean(), brief]))
                    .length(6)
                    .describe(
                        `六行 [passed, evidence]，顺序严格为 ${gateNames.join(", ")}；每项均须实际判断`,
                    ),
            }),
        )
        .min(1)
        .max(64),
    slotEvidence: z.record(
        z.string(),
        slot.extend({
            featureAuthority: z
                .record(
                    slot.shape.featureAuthority.unwrap().keyType,
                    authority.extend({ evidence: brief }),
                )
                .nullable()
                .describe(
                    "仅 replace_identity 需要九轴具名权限 {owner,basis,evidence,runtimeFactRef}；其他槽位为 null",
                ),
        }),
    ),
    tagEvidence: z
        .record(z.string(), z.tuple([brief, brief, tag.category]))
        .describe("每个标签 [visualEvidence, searchIntent, category]"),
});
// 请求字段顺序遵循观察、取舍、编译，避免在逐区观察前先生成取舍结论。
const {
    imageObservation,
    visualMechanism,
    componentGraph,
    identityTopology,
    textRegions,
    containers,
    fixedStructure,
    fieldEvidence,
    mediumComposition,
    visualSelections,
    semanticModel,
    ...decisions
} = compactFields.shape;
export const compactAnalysisSchema = z.strictObject({
    imageObservation,
    visualMechanism,
    componentGraph,
    identityTopology,
    textRegions,
    containers,
    fixedStructure,
    fieldEvidence,
    ...decisions,
    mediumComposition,
    visualSelections,
    semanticModel,
});
const compactPlanSchema = z.strictObject({
    analysis: compactAnalysisSchema,
    draft: z.unknown(),
});
const compactCheckSchema = z.strictObject({
    passed: z.boolean(),
    evidence: z
        .array(
            z.strictObject({
                path: z
                    .string()
                    .regex(
                        new RegExp(
                            `^/(draft/|analysis/(${Object.keys(templateAnalysisSchema.shape).join("|")})(/|$))`,
                        ),
                    ),
                observation: z.string().trim().min(1).max(500),
            }),
        )
        .min(1)
        .max(8),
});
const compactReviewSchema = z.strictObject({
    checks: z
        .strictObject(
            Object.fromEntries(
                reviewChecks.map((name) => [name, compactCheckSchema]),
            ) as Record<
                (typeof reviewChecks)[number],
                typeof compactCheckSchema
            >,
        )
        .extend({
            visualContractRespectsInputs: compactCheckSchema.extend({
                evidence: z.union([
                    compactCheckSchema.shape.evidence,
                    z.strictObject({
                        observations: compactCheckSchema.shape.evidence.max(2),
                        selections: compactCheckSchema.shape.evidence.max(2),
                        visualContract:
                            compactCheckSchema.shape.evidence.max(4),
                    }),
                ]),
            }),
            slotRecallComplete: compactCheckSchema.extend({
                evidence: z.union([
                    compactCheckSchema.shape.evidence,
                    z.strictObject(
                        Object.fromEntries(
                            reviewAxes.map((axis) => [
                                axis,
                                compactCheckSchema.shape.evidence.element,
                            ]),
                        ) as Record<
                            (typeof reviewAxes)[number],
                            typeof compactCheckSchema.shape.evidence.element
                        >,
                    ),
                ]),
            }),
            textEditLayersComplete: compactCheckSchema.extend({
                evidence: z.union([
                    compactCheckSchema.shape.evidence,
                    z.strictObject({
                        textRegions: compactCheckSchema.shape.evidence.max(4),
                        visualContract:
                            compactCheckSchema.shape.evidence.max(4),
                    }),
                ]),
            }),
        })
        .describe(
            "每项 {passed,evidence:[{path,observation}]}，十九项全部返回；路径指向展开后的候选",
        ),
    issues: z.array(brief).max(19),
});
export const compactInspectionSchema = templateInspectionSchema.extend({
    // 任意 JSON 值不能作为严格输出对象的开放属性，用字符串传输后再走原合同。
    changes: z
        .array(
            z.strictObject({
                path: templateInspectionSchema.shape.changes.element.shape.path,
                valueJson: z
                    .string()
                    .min(1)
                    .max(100_000)
                    .describe(
                        "替换值的合法 JSON 编码；字符串含双引号，数组和对象也完整编码",
                    ),
            }),
        )
        .max(64),
    review: compactReviewSchema,
});

export function templateInspectionResponseSchema(plan: object, digest: string) {
    const paths = templateCorrectionPaths(plan);
    const evidencePaths = inspectionEvidencePaths(plan).filter(
        (path) =>
            compactCheckSchema.shape.evidence.element.shape.path.safeParse(path)
                .success &&
            !/\/(targetScopes|backendFactRefs|relationIndex|runtimeFactRef|layoutRefs)(\/|$)/.test(
                path,
            ),
    );
    const check = compactCheckSchema.extend({
        evidence: z
            .array(
                compactCheckSchema.shape.evidence.element.extend({
                    path: z.enum(evidencePaths),
                }),
            )
            .min(1)
            .max(8),
    });
    const textPaths = evidencePaths.filter((path) =>
        path.startsWith("/analysis/textRegions/"),
    );
    const evidenceGroup = (prefix: string) => {
        const group = evidencePaths.filter(
            (path) => path === prefix || path.startsWith(`${prefix}/`),
        );
        if (!group.length)
            throw new TemplateContractError(["独立复核缺少必需字段的证据范围"]);
        return z
            .array(
                compactCheckSchema.shape.evidence.element.extend({
                    path: z.enum(group),
                }),
            )
            .min(1)
            .max(4);
    };
    const textCheck = textPaths.length
        ? check.extend({
              evidence: z
                  .strictObject({
                      textRegions: evidenceGroup("/analysis/textRegions"),
                      visualContract: evidenceGroup(
                          "/analysis/semanticModel/runtimeSemantics/visualContract",
                      ),
                  })
                  .describe(
                      "先依据附件记录文字观察，再核验正式约束；两组都须给出具体观察，不能用父对象代替",
                  ),
          })
        : check;
    return compactInspectionSchema.extend({
        reviewedPlanSha256: z.literal(digest),
        changes: z
            .array(
                compactInspectionSchema.shape.changes.element.extend({
                    path: z.enum(paths),
                }),
            )
            .max(64),
        review: compactReviewSchema.extend({
            checks: z
                .strictObject(
                    Object.fromEntries(
                        reviewChecks.map((name) => [name, check]),
                    ) as Record<(typeof reviewChecks)[number], typeof check>,
                )
                .extend({
                    visualContractRespectsInputs: check.extend({
                        evidence: z
                            .strictObject({
                                observations: evidenceGroup(
                                    "/analysis/fieldEvidence/visualContract",
                                ).max(2),
                                selections: evidenceGroup(
                                    "/analysis/visualSelections",
                                ).max(2),
                                visualContract: evidenceGroup(
                                    "/analysis/semanticModel/runtimeSemantics/visualContract",
                                ),
                            })
                            .describe(
                                "先独立看图找遗漏与误读，再逐项判断保留或舍弃是否合理，最后检查执行约束与开放输入。不得仅确认已有引用一致；发现重要特征未观察或无理由舍弃，修正其观察、取舍及相关约束后再报告",
                            ),
                    }),
                    textEditLayersComplete: textCheck,
                    slotRecallComplete: check.extend({
                        evidence: z.strictObject(
                            Object.fromEntries(
                                reviewAxes.map((axis) => [
                                    axis,
                                    evidenceGroup(
                                        `/analysis/slotCoverageReview/${axis}`,
                                    ).element,
                                ]),
                            ) as Record<
                                (typeof reviewAxes)[number],
                                ReturnType<typeof evidenceGroup>["element"]
                            >,
                        ),
                    }),
                }),
        }),
    });
}

/** 按分析项与正式合同字段提供证据范围，不受补丁路径数量和数组顺序截断。 */
function inspectionEvidencePaths(plan: object): string[] {
    const paths = new Set<string>();
    const visit = (value: unknown, path: string, depth: number) => {
        if (!value || typeof value !== "object" || depth === 0) return;
        for (const [key, child] of Object.entries(value)) {
            if (!key || ["__proto__", "constructor", "prototype"].includes(key))
                continue;
            const pointer = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
            if (pointer.length > 500) continue;
            paths.add(pointer);
            visit(child, pointer, depth - 1);
        }
    };
    for (const root of [
        ["analysis"],
        ["draft"],
        ["analysis", "semanticModel", "runtimeSemantics"],
    ]) {
        let value: unknown = plan;
        for (const key of root)
            value =
                value && typeof value === "object" && Object.hasOwn(value, key)
                    ? (value as Record<string, unknown>)[key]
                    : undefined;
        visit(value, `/${root.join("/")}`, 2);
    }
    return [...paths];
}

export function expandTemplatePlan(value: unknown) {
    const parsed = compactPlanSchema.safeParse(value);
    if (!parsed.success)
        throw new TemplateProjectionError(
            value,
            parsed.error.issues
                .slice(0, 16)
                .map((issue) => `/${issue.path.join("/")}: ${issue.message}`),
            validationDiagnostics(parsed.error.issues),
        );
    const { analysis: a, draft } = parsed.data;
    return {
        draft,
        analysis: {
            ...a,
            componentGraph: a.componentGraph.map(
                ([id, evidence, visualFields]) => ({
                    id,
                    evidence,
                    visualFields,
                }),
            ),
            spatialRelations: a.spatialRelations.map(
                ([componentIds, evidence, relationIndex]) => ({
                    componentIds,
                    evidence,
                    relationIndex,
                }),
            ),
            slotCoverageReview: Object.fromEntries(
                Object.entries(a.slotCoverageReview).map(
                    ([key, [componentIds, slotIds, evidence]]) => [
                        key,
                        { componentIds, slotIds, evidence },
                    ],
                ),
            ),
            editableCandidates: a.editableCandidates.map((item) => ({
                ...item,
                gates: Object.fromEntries(
                    gateNames.map((name, index) => [
                        name,
                        {
                            passed: item.gates[index][0],
                            evidence: item.gates[index][1],
                        },
                    ]),
                ),
            })),
            tagEvidence: Object.fromEntries(
                Object.entries(a.tagEvidence).map(
                    ([key, [visualEvidence, searchIntent, category]]) => [
                        key,
                        { visualEvidence, searchIntent, category },
                    ],
                ),
            ),
        },
    };
}

export function expandTemplateInspection(value: unknown) {
    const parsed = compactInspectionSchema.safeParse(value);
    if (!parsed.success)
        throw new TemplateProjectionError(
            value,
            parsed.error.issues
                .slice(0, 16)
                .map((issue) => `/${issue.path.join("/")}: ${issue.message}`),
            validationDiagnostics(parsed.error.issues),
        );
    const textCheck = parsed.data.review.checks.textEditLayersComplete;
    const recallCheck = parsed.data.review.checks.slotRecallComplete;
    const visualCheck = parsed.data.review.checks.visualContractRespectsInputs;
    return {
        ...parsed.data,
        review: {
            ...parsed.data.review,
            checks: {
                ...parsed.data.review.checks,
                visualContractRespectsInputs: {
                    ...visualCheck,
                    evidence: Array.isArray(visualCheck.evidence)
                        ? visualCheck.evidence
                        : [
                              ...visualCheck.evidence.observations,
                              ...visualCheck.evidence.selections,
                              ...visualCheck.evidence.visualContract,
                          ],
                },
                slotRecallComplete: {
                    ...recallCheck,
                    evidence: Array.isArray(recallCheck.evidence)
                        ? recallCheck.evidence
                        : Object.values(recallCheck.evidence),
                },
                textEditLayersComplete: {
                    ...textCheck,
                    evidence: Array.isArray(textCheck.evidence)
                        ? textCheck.evidence
                        : [
                              ...textCheck.evidence.textRegions,
                              ...textCheck.evidence.visualContract,
                          ],
                },
            },
        },
        changes: parsed.data.changes.map(({ path, valueJson }, index) => {
            try {
                return { path, value: JSON.parse(valueJson) as unknown };
            } catch {
                throw new TemplateProjectionError(
                    value,
                    [`/changes/${index}/valueJson: 必须是合法 JSON`],
                    [
                        {
                            path: `/changes/${index}/valueJson`,
                            code: "invalid_format",
                        },
                    ],
                );
            }
        }),
    };
}
