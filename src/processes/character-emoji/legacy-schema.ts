/** legacy-schema.ts：移植 Memebuy AI 角色表情包的固定规则与校验。 */
import { z } from "zod";

import { characters } from "./catalog.js";

export const briefSchema = z
    .object({
        character: z.enum(
            characters
                .filter((item) => item.id !== "Doubao")
                .map((item) => item.id),
        ),
        appearance: z.enum(["Chibi", "Girl"]),
        idea: z.string().trim().min(1).max(200),
        // 兼容历史任务和待确认提交，新创作不再使用感觉选项。
        tone: z.enum(["轻松吐槽", "软萌可爱", "夸张发疯"]).optional(),
    })
    .strict();

export const planSchema = z
    .object({
        caption: z.string().trim().max(28),
        joke: z.string().trim().min(1).max(80),
        expression: z.string().trim().min(1).max(45),
        action: z.string().trim().min(1).max(90),
        composition: z.string().trim().min(1).max(65),
        identityClues: z.string().trim().min(1).max(75),
        punchlineDetail: z.string().trim().min(1).max(65),
        identityMark: z
            .object({
                text: z.string().trim().min(1).max(40),
                carrier: z.string().trim().min(1).max(30),
                placement: z.string().trim().min(1).max(30),
            })
            .strict()
            .nullable(),
    })
    .strict();
export const compositionSchema = z
    .object({
        brief: briefSchema,
        plan: planSchema,
        // 自动构思后的生成快照；最终提示词仍须经过服务端审核。
        caption: z.string().trim().max(28),
        scene: z.string().trim().min(1).max(600),
    })
    .strict();
export const submissionSchema = compositionSchema.extend({
    submissionId: z.uuid(),
});
export type Composition = z.infer<typeof compositionSchema>;

export const emojiTaskContextSchema = compositionSchema.extend({
    version: z.literal(1),
    maker: z.literal("ai-character-emoji"),
    promptVersion: z.string().min(1),
});
