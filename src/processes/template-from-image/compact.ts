/** 将模型的紧凑分析和复核无损还原为原校验合同，不推断或补填结论。 */
import { z } from "zod";
import { templateInspectionSchema } from "./inspection.js";
import {
    TemplateProjectionError,
    templatePlanAnalysisSchema,
} from "./projection.js";
import { reviewChecks } from "./quality.js";

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
const compactReviewSchema = z.strictObject({
    checks: z
        .record(
            z.enum(reviewChecks),
            z.strictObject({
                passed: z.boolean(),
                evidence: z
                    .array(
                        z.strictObject({
                            path: z.string().regex(/^\/(draft|analysis)\//),
                            observation: brief,
                        }),
                    )
                    .min(1)
                    .max(8),
            }),
        )
        .describe(
            "每项 {passed,evidence:[{path,observation}]}，十九项全部返回；路径指向展开后的候选",
        ),
    issues: z.array(brief).max(19),
});
export const compactInspectionSchema = templateInspectionSchema.extend({
    review: compactReviewSchema,
});

export function expandTemplatePlan(value: unknown) {
    const parsed = compactPlanSchema.safeParse(value);
    if (!parsed.success)
        throw new TemplateProjectionError(
            value,
            parsed.error.issues
                .slice(0, 16)
                .map((issue) => `/${issue.path.join("/")}: ${issue.message}`),
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
        );
    return parsed.data;
}
