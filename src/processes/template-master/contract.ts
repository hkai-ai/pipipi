/** 定义母版生成的双模式输入合同（sourceRunId 直读与兼容直传）、输出合同、档位与校验项词表。 */
import { z } from "zod";
import { sourcePhotoSchema } from "../photo-poster/capability.js";
import {
    bindingSchema,
    printDesignOutputSchema,
    sourceConditionSchema,
    textModes,
} from "../template-from-image/design-spec/contract.js";
import { designSpecSchema } from "../template-from-image/design-spec/vendor/design-spec-schema.js";

export const masterTiers = ["light", "medium", "heavy"] as const;
export type MasterTier = (typeof masterTiers)[number];
export const masterChecks = [
    "text",
    "palette",
    "layout",
    "printable",
    "similarity",
    "generation",
] as const;
export type MasterCheckName = (typeof masterChecks)[number];

export const masterBudgetSchema = z.strictObject({
    maxAttempts: z.int().min(1).max(10).describe("最大尝试次数（1–10）。"),
    maxUsd: z
        .number()
        .min(0)
        .max(20)
        .describe("本次运行的已知 USD 费用上限（0–20；未知费用不计入）。"),
});

/**
 * 兼容直传模式的模板草稿 Schema：
 * - 允许并忽略 `template-from-image/v3` 完整产物及业务侧附加的非核心字段；
 * - 标题、描述、标签约束对齐上游输出；
 * - 仅保留母版生成真正必需的 `key`、`inputSchema`（v2）与 `runtimeSemantics`（v4）。
 */
export const masterTemplateSchema = z.object({
    key: z.string().regex(/^[a-z][a-z0-9-]{1,59}$/u),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).nullable().optional(),
    metadata: z
        .object({
            tags: z.array(z.string()).optional(),
        })
        .nullable()
        .optional(),
    inputSchema: z.object({
        version: z.literal(2),
        slots: z
            .array(
                z.looseObject({
                    id: z.string(),
                    label: z.string(),
                    required: z.literal(false),
                    text: textModes,
                    image: z
                        .looseObject({
                            sourceOptions: z
                                .array(
                                    z.enum([
                                        "upload",
                                        "recent_upload",
                                        "asset_library",
                                    ]),
                                )
                                .min(1),
                            maxCount: z.literal(1),
                            private: z.literal(true),
                        })
                        .optional(),
                    resolutionStrategy: z.literal("image_over_text").optional(),
                }),
            )
            .min(1)
            .max(12),
    }),
    runtimeSemantics: z.object({
        version: z.literal(4),
        targetInstances: z
            .array(
                z.looseObject({
                    id: z.string(),
                    kind: z.enum(["identity_subject", "content_element"]),
                    role: z.string(),
                    region: z.string(),
                }),
            )
            .min(1),
        inputBindings: z.record(z.string(), bindingSchema),
        designSpec: designSpecSchema,
    }),
});
export type MasterTemplate = z.infer<typeof masterTemplateSchema>;

/** 模式 A（推荐）：按同 caller 的上游 template-from-image 运行 ID 直读产物。 */
export const masterSourceRunInputSchema = z
    .strictObject({
        imageUrl: sourcePhotoSchema,
        sourceRunId: z
            .string()
            .trim()
            .min(1)
            .max(256)
            .describe(
                "同 callerId 已成功的上游 template-from-image 运行 ID；服务端在受理阶段校验并快照其产物。",
            ),
        budget: masterBudgetSchema,
    })
    .describe("模式 A（推荐）：通过 sourceRunId 直读同 caller 上游拆解产物。");
export type MasterSourceRunInput = z.infer<typeof masterSourceRunInputSchema>;

export const sourceTextsSchema =
    printDesignOutputSchema.shape.source.shape.texts;

/** 模式 B（兼容直传）：由调用方直接回传 v4 模板草稿、原图状况及可选逐字原文清单。 */
export const masterDirectInputSchema = z
    .strictObject({
        imageUrl: sourcePhotoSchema,
        template: masterTemplateSchema.describe(
            "兼容原样透传的 template-from-image/v3 草稿对象（保留核心 v2 inputSchema 与 v4 runtimeSemantics 校验）。",
        ),
        condition: sourceConditionSchema.describe(
            "原图状况对象（同 template-from-image/v3 的 source.condition）。",
        ),
        sourceTexts: sourceTextsSchema
            .optional()
            .describe(
                "可选权威原图逐字文字清单（同 template-from-image/v3 的 source.texts），用于判定是否跳过原图处理直接重绘。",
            ),
        budget: masterBudgetSchema,
    })
    .describe(
        "模式 B（兼容直传）：直接回传 v4 草稿、原图状况与可选 sourceTexts。",
    );
export type MasterDirectInput = z.infer<typeof masterDirectInputSchema>;

export const masterInputSchema = z
    .union([masterSourceRunInputSchema, masterDirectInputSchema])
    .describe(
        "母版生成二选一输入：使用 sourceRunId 直读，或兼容直传 template + condition。",
    );
export type MasterInput = z.infer<typeof masterInputSchema>;

/** 服务端受理阶段解析完成后的执行输入（可选保留 sourceRunId 供控制台溯源）。 */
export type ResolvedMasterInput = MasterDirectInput &
    Readonly<{
        sourceRunId?: string;
    }>;

export function isSourceRunMasterInput(
    input: unknown,
): input is MasterSourceRunInput {
    return (
        typeof input === "object" &&
        input !== null &&
        "sourceRunId" in input &&
        typeof (input as Record<string, unknown>).sourceRunId === "string" &&
        !("template" in input)
    );
}

const failureSchema = z.strictObject({
    check: z.enum(masterChecks),
    detail: z.string().max(200),
});
export type MasterFailure = z.infer<typeof failureSchema>;
const tierSchema = z.enum(masterTiers);

/** 母版成图上传后的内容寻址描述；sha256 同时是对象键与校验摘要。 */
export const preparedImageSchema = z.strictObject({
    url: sourcePhotoSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.int().min(64).max(4096),
    height: z.int().min(64).max(4096),
    contentType: z.literal("image/png"),
});

export const masterOutputSchema = z.strictObject({
    preparedImage: preparedImageSchema,
    master: z.strictObject({
        tier: tierSchema,
        redrawn: z.boolean(),
        backgroundKept: z.boolean().optional(),
        attempts: z
            .array(
                z.strictObject({
                    tier: tierSchema,
                    passed: z.boolean(),
                    failures: z.array(failureSchema),
                    reason: z.string().max(200).optional(),
                }),
            )
            .min(1)
            .max(10),
        checks: z.strictObject({
            text: z.strictObject({
                passed: z.boolean(),
                expected: z.array(z.string()),
                read: z.array(z.string()),
            }),
            palette: z.strictObject({ passed: z.boolean() }),
            layout: z.strictObject({ passed: z.boolean() }),
            printable: z.strictObject({ passed: z.boolean() }),
            similarity: z
                .strictObject({
                    passed: z.boolean(),
                    score: z.number().min(0).max(1).optional(),
                })
                .nullable(),
        }),
    }),
});
export type MasterOutput = z.infer<typeof masterOutputSchema>;
