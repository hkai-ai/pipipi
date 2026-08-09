import { z } from "zod";
import {
    defineProcessRegistration,
    type ExpectedProcessFailure,
    failProcess,
    type ProcessExecutionContext,
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
                return executeDirect(preparedContent, context, capability);
            }

            if (!agent) throw new Error("Agent Runtime is unavailable");
            return executeWithAgent(
                preparedContent,
                context,
                capability,
                agent,
            );
        },
    });
}

async function executeDirect(
    content: string,
    context: ProcessExecutionContext,
    capability: ContentProcessingCapability,
): Promise<{ content: string } | ExpectedProcessFailure> {
    try {
        return await capability.process(
            { content },
            { signal: context.signal, idempotencyKey: context.runId },
        );
    } catch (error) {
        if (error instanceof ContentProcessingUnavailable) {
            return dependencyFailure();
        }
        throw error;
    }
}

async function executeWithAgent(
    content: string,
    context: ProcessExecutionContext,
    capability: ContentProcessingCapability,
    agent: ContentAgent,
): Promise<{ content: string } | ExpectedProcessFailure> {
    const observed: {
        calls: number;
        result?: { content: string };
        dependencyUnavailable: boolean;
    } = { calls: 0, dependencyUnavailable: false };
    const permittedCapability: ContentProcessingCapability = {
        process: async (input, options) => {
            observed.calls += 1;
            if (observed.calls !== 1) {
                throw new Error(
                    "The Agent must call the Business Capability exactly once",
                );
            }
            try {
                const result = await capability.process(input, {
                    signal: AbortSignal.any([context.signal, options.signal]),
                    idempotencyKey: context.runId,
                });
                observed.result = result;
                return result;
            } catch (error) {
                if (error instanceof ContentProcessingUnavailable) {
                    observed.dependencyUnavailable = true;
                }
                throw error;
            }
        },
    };

    try {
        const rawOutput = await agent.optimize({
            content,
            signal: context.signal,
            idempotencyKey: context.runId,
            capability: permittedCapability,
        });
        if (observed.dependencyUnavailable) return dependencyFailure();
        if (observed.calls !== 1 || !observed.result) return agentFailure();

        const output = contentProcessOutputSchema.safeParse(rawOutput);
        const toolResult = contentProcessOutputSchema.safeParse(
            observed.result,
        );
        if (
            !output.success ||
            !toolResult.success ||
            output.data.content !== toolResult.data.content
        ) {
            return agentFailure();
        }
        return toolResult.data;
    } catch (error) {
        if (
            error instanceof ContentProcessingUnavailable ||
            observed.dependencyUnavailable
        ) {
            return dependencyFailure();
        }
        return agentFailure();
    }
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
