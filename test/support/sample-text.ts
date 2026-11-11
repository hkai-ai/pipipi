/** 测试专用文本 Process：规范化空白后调用注入的 Capability，供 Runtime 与 HTTP 边界测试复用，不进入 production catalog */
import { z } from "zod";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
    type ProcessRetryPolicy,
} from "../../src/process-runtime/index.js";

export type SampleTextCapability = {
    process: (
        input: { content: string },
        options: { signal: AbortSignal; idempotencyKey: string },
    ) => Promise<{ content: string }>;
};

/** Thrown by a test Capability to stand in for an unavailable dependency. */
export class SampleTextUnavailable extends Error {
    constructor() {
        super("Sample text dependency is unavailable");
        this.name = "SampleTextUnavailable";
    }
}

const textSchema = z.strictObject({ content: z.string().trim().min(1) });

export function createSampleTextRegistration(
    capability: SampleTextCapability,
    options: { retryPolicy?: ProcessRetryPolicy } = {},
): ProcessRegistration {
    return defineProcessRegistration({
        id: "sample-text",
        version: "v1",
        inputSchema: textSchema,
        outputSchema: textSchema,
        activities: ["text_processing"],
        retryPolicy: options.retryPolicy,
        execute: async (input, context) => {
            try {
                return await context.runActivity("text_processing", async () =>
                    capability.process(
                        { content: input.content.replace(/\s+/g, " ") },
                        {
                            signal: context.signal,
                            idempotencyKey: context.runId,
                        },
                    ),
                );
            } catch (error) {
                if (error instanceof SampleTextUnavailable) {
                    return failProcess(
                        "DEPENDENCY_FAILURE",
                        "A required business service is unavailable",
                    );
                }
                throw error;
            }
        },
    });
}
