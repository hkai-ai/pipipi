/** 定义母版生成的输入输出合同、档位与校验项词表。 */
import { z } from "zod";
import { sourcePhotoSchema } from "../photo-poster/capability.js";
import {
    draftSchema,
    sourceConditionSchema,
} from "../template-from-image/design-spec/contract.js";
import { preparedTemplateImageSchema } from "../template-from-source/capability.js";

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

export const masterInputSchema = z.strictObject({
    imageUrl: sourcePhotoSchema,
    // 第 2 块回传的 v4 作者草稿；按 Pipipi 自己的 draftSchema 校验，不信任调用方整形。
    template: draftSchema,
    condition: sourceConditionSchema,
    budget: z.strictObject({
        maxAttempts: z.int().min(1).max(10),
        maxUsd: z.number().min(0).max(20),
    }),
});
export type MasterInput = z.infer<typeof masterInputSchema>;

const failureSchema = z.strictObject({
    check: z.enum(masterChecks),
    detail: z.string().max(200),
});
export type MasterFailure = z.infer<typeof failureSchema>;
const tierSchema = z.enum(masterTiers);

export const masterOutputSchema = z.strictObject({
    preparedImage: preparedTemplateImageSchema,
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
