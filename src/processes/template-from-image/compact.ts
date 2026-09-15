/** 将模型的紧凑分析和复核无损还原为原校验合同，不推断或补填结论。 */
import { z } from "zod";
import { templateCorrectionPaths } from "./correction.js";
import { validationDiagnostics } from "./diagnostics.js";
import { templateInspectionSchema } from "./inspection.js";
import {
    TemplateProjectionError,
    templatePlanAnalysisSchema,
} from "./projection.js";
import { reviewChecks, templateAnalysisSchema } from "./quality.js";

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

export const compactAnalysisSchema = templatePlanAnalysisSchema.extend({
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
            substitutions: z
                .array(
                    z.tuple([
                        slot.shape.substitutions.element.shape.value,
                        brief,
                    ]),
                )
                .length(3)
                .describe("三个推荐项各为 [value, 实际替换后的语义证据]"),
        }),
    ),
    tagEvidence: z
        .record(z.string(), z.tuple([brief, brief, tag.category]))
        .describe("每个标签 [visualEvidence, searchIntent, category]"),
});
const compactPlanSchema = z.strictObject({
    draft: z.unknown(),
    analysis: compactAnalysisSchema,
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
                observation: brief,
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
    const evidencePaths = paths.filter(
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
            checks: z.strictObject(
                Object.fromEntries(
                    reviewChecks.map((name) => [name, check]),
                ) as Record<(typeof reviewChecks)[number], typeof check>,
            ),
        }),
    });
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
            slotEvidence: Object.fromEntries(
                Object.entries(a.slotEvidence).map(([key, item]) => [
                    key,
                    {
                        ...item,
                        substitutions: item.substitutions.map(
                            ([value, evidence]) => ({ value, evidence }),
                        ),
                    },
                ]),
            ),
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
    return {
        ...parsed.data,
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
