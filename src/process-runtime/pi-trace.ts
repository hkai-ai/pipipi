/** 定义可归档的 Pi 会话元数据，并按白名单净化历史记录。 */
import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const identifier = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const usage = z.object({
    input: count.optional(),
    output: count.optional(),
    cacheRead: count.optional(),
    cacheWrite: count.optional(),
    reasoning: count.optional(),
    totalTokens: count.optional(),
});
const call = z.object({
    call: count.positive(),
    name: identifier.optional(),
    result: z.enum(["returned", "error"]).optional(),
    durationMs: count.optional(),
});
const round = z.object({
    round: count.positive(),
    model: identifier.optional(),
    tools: z.array(identifier).max(64).optional(),
    calls: z.array(call).max(64),
    outcome: z
        .enum([
            "stop",
            "length",
            "toolUse",
            "error",
            "aborted",
            "deferred",
            "pending",
        ])
        .optional(),
    durationMs: count.optional(),
    usage: usage.optional(),
});
const session = z.object({
    sessionId: count.positive(),
    skills: z
        .array(
            z.object({
                name: identifier,
                version: z
                    .string()
                    .regex(/^v\d+(?:\.\d+){0,2}$/)
                    .max(32)
                    .optional(),
            }),
        )
        .max(64),
    rounds: z.array(round).max(64),
    validation: z.enum(["passed", "failed"]).optional(),
});
export type PiSessionTrace = z.infer<typeof session>;
export type PiRoundTrace = z.infer<typeof round>;
export function sanitizePiSessions(
    input: unknown,
): PiSessionTrace[] | undefined {
    if (!Array.isArray(input) || input.length > 32) return undefined;
    const parsed = z.array(session).safeParse(input);
    return parsed.success ? parsed.data : undefined;
}
