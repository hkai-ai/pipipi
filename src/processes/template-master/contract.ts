/** 定义母版生成的双模式输入合同（sourceRunId 直读与兼容直传）、输出合同、档位与校验项词表。 */
import { z } from "zod";
import { sourcePhotoSchema } from "../photo-poster/capability.js";
import {
    bindingSchema,
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
    maxAttempts: z.int().min(1).max(10),
    maxUsd: z.number().min(0).max(20),
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
export const masterSourceRunInputSchema = z.strictObject({
    imageUrl: sourcePhotoSchema,
    sourceRunId: z.string().trim().min(1).max(256),
    budget: masterBudgetSchema,
});
export type MasterSourceRunInput = z.infer<typeof masterSourceRunInputSchema>;

/** 模式 B（兼容直传）：由调用方直接回传 v4 模板草稿与原图状况。 */
export const masterDirectInputSchema = z.strictObject({
    imageUrl: sourcePhotoSchema,
    template: masterTemplateSchema,
    condition: sourceConditionSchema,
    budget: masterBudgetSchema,
});
export type MasterDirectInput = z.infer<typeof masterDirectInputSchema>;

export const masterInputSchema = z.union([
    masterSourceRunInputSchema,
    masterDirectInputSchema,
]);
export type MasterInput = z.infer<typeof masterInputSchema>;

/** 服务端受理阶段解析完成后的执行输入（可选保留 sourceRunId 供控制台溯源）。 */
export type ResolvedMasterInput = MasterDirectInput &
    Readonly<{ sourceRunId?: string }>;

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
        attempts: z
            .array(
                z.strictObject({
                    tier: tierSchema,
                    passed: z.boolean(),
                    failures: z.array(failureSchema),
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
