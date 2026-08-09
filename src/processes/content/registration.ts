import { z } from "zod";
import {
    defineProcessRegistration,
    type ExpectedProcessFailure,
    failProcess,
    type ProcessRegistration,
    type ProcessRetryPolicy,
} from "../runtime/index.js";
import type { ContentOptimizationAgentRuntime } from "./agent.js";
import {
    type ContentProcessingCapability,
    ContentProcessingUnavailable,
} from "./capability.js";

const contentProcessInputSchema = z.strictObject({
    content: z.string().trim().min(1),
});

const contentProcessOutputSchema = z.strictObject({
    content: z.string().trim().min(1),
});

export type ContentProcessingRegistrationOptions = {
    contentProcessing: ContentProcessingCapability;
    agentRuntime?: ContentOptimizationAgentRuntime;
    mode?: "direct" | "agent";
    retryPolicy?: ProcessRetryPolicy;
};

export type ContentProcessingProcessConfig = {
    mode?: "direct" | "agent";
    retryPolicy?: ProcessRetryPolicy;
};

export function createContentProcessingRegistration(
    options: ContentProcessingRegistrationOptions,
): ProcessRegistration {
    if (
        typeof options.contentProcessing !== "object" ||
        options.contentProcessing === null ||
        typeof options.contentProcessing.process !== "function"
    ) {
        throw new Error("Content Processing Capability is required");
    }
    const mode = options.mode ?? "direct";
    if (mode !== "direct" && mode !== "agent") {
        throw new Error("Content processing mode must be direct or agent");
    }
    const contentProcessing = options.contentProcessing;
    const agentRuntime = options.agentRuntime;
    if (
        mode === "agent" &&
        (typeof agentRuntime !== "object" ||
            agentRuntime === null ||
            typeof agentRuntime.optimize !== "function")
    ) {
        throw new Error("Agent Runtime is required when Agent mode is enabled");
    }

    return defineProcessRegistration({
        id: "content-processing",
        version: "v1",
        inputSchema: contentProcessInputSchema,
        outputSchema: contentProcessOutputSchema,
        retryPolicy: options.retryPolicy,
        execute: async (input, context) => {
            const preparedContent = input.content.replace(/\s+/g, " ");
            if (mode === "direct") {
                try {
                    return await contentProcessing.process(
                        { content: preparedContent },
                        {
                            signal: context.signal,
                            idempotencyKey: context.runId,
                        },
                    );
                } catch (error) {
                    if (error instanceof ContentProcessingUnavailable) {
                        return dependencyFailure();
                    }
                    throw error;
                }
            }

            if (!agentRuntime) throw new Error("Agent Runtime is unavailable");
            try {
                const rawOutput = await agentRuntime.optimize({
                    content: preparedContent,
                    signal: context.signal,
                    idempotencyKey: context.runId,
                    contentProcessing,
                });
                const output = contentProcessOutputSchema.safeParse(rawOutput);
                if (!output.success) return agentFailure();
                return output.data;
            } catch (error) {
                if (error instanceof ContentProcessingUnavailable) {
                    return dependencyFailure();
                }
                return agentFailure();
            }
        },
    });
}

function agentFailure(): ExpectedProcessFailure {
    return failProcess(
        "AGENT_FAILURE",
        "The content optimization agent could not complete the request",
    );
}

function dependencyFailure(): ExpectedProcessFailure {
    return failProcess(
        "DEPENDENCY_FAILURE",
        "A required business service is unavailable",
    );
}
