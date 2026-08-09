import { z } from "zod";
import {
    defineProcessRegistration,
    type ExpectedProcessFailure,
    failProcess,
    type ProcessRegistration,
    type ProcessRetryPolicy,
} from "../runtime/index.js";
import type { ContentAgent } from "./agent.js";
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

type RegistrationOptions = {
    capability: ContentProcessingCapability;
    agent?: ContentAgent;
    mode?: "direct" | "agent";
    retryPolicy?: ProcessRetryPolicy;
};

export type ContentProcessConfig = {
    mode?: "direct" | "agent";
    retryPolicy?: ProcessRetryPolicy;
};

export function createContentRegistration(
    options: RegistrationOptions,
): ProcessRegistration {
    if (
        typeof options.capability !== "object" ||
        options.capability === null ||
        typeof options.capability.process !== "function"
    ) {
        throw new Error("Content Processing Capability is required");
    }
    const mode = options.mode ?? "direct";
    if (mode !== "direct" && mode !== "agent") {
        throw new Error("Content processing mode must be direct or agent");
    }
    const capability = options.capability;
    const agent = options.agent;
    if (
        mode === "agent" &&
        (typeof agent !== "object" ||
            agent === null ||
            typeof agent.optimize !== "function")
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
                    return await capability.process(
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

            if (!agent) throw new Error("Agent Runtime is unavailable");
            try {
                const rawOutput = await agent.optimize({
                    content: preparedContent,
                    signal: context.signal,
                    idempotencyKey: context.runId,
                    capability,
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
