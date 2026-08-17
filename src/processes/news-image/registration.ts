import { z } from "zod";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../../process-runtime/index.js";
import type { NewsImageAgent } from "./agent.js";
import {
    type NewsImageRenderingCapability,
    NewsImageRenderingUnavailable,
    type NewsImageStyle,
    newsImageSchema,
} from "./capability.js";

const inputSchema = z.strictObject({
    title: z.string().trim().min(1).max(300),
    summary: z.string().trim().min(1).max(12_000),
});

type NewsImageRegistrationOptions = Readonly<{
    agent: NewsImageAgent;
    capability: NewsImageRenderingCapability;
}>;

type NewsImagePolicy = Readonly<{
    id: `news-image-${NewsImageStyle}`;
    agentRequiredMessage: string;
    capabilityRequiredMessage: string;
    agentFailureMessage: string;
    promptErrorMessage: string;
    hasPromptContract: (prompt: string) => boolean;
}>;

const policies = {
    "narrative-monument": {
        id: "news-image-narrative-monument",
        agentRequiredMessage: "Narrative Monument Agent is required",
        capabilityRequiredMessage:
            "Narrative Monument Rendering Capability is required",
        agentFailureMessage:
            "The narrative monument prompt agent could not complete the request",
        promptErrorMessage: "Narrative monument prompt is invalid",
        hasPromptContract: hasNarrativeMonumentPromptContract,
    },
    "pale-watercolor": {
        id: "news-image-pale-watercolor",
        agentRequiredMessage: "News Image Agent is required",
        capabilityRequiredMessage:
            "News Image Rendering Capability is required",
        agentFailureMessage:
            "The news image prompt agent could not complete the request",
        promptErrorMessage: "News image prompt contract is invalid",
        hasPromptContract: hasPaleWatercolorPromptContract,
    },
    "raw-humanism": {
        id: "news-image-raw-humanism",
        agentRequiredMessage: "Raw Humanism News Image Agent is required",
        capabilityRequiredMessage:
            "Raw Humanism Rendering Capability is required",
        agentFailureMessage:
            "The raw humanism prompt agent could not complete the request",
        promptErrorMessage: "Raw humanism prompt contract is invalid",
        hasPromptContract: hasRawHumanismPromptContract,
    },
} satisfies Record<NewsImageStyle, NewsImagePolicy>;

export function createNewsImageRegistration(
    style: NewsImageStyle,
    options: NewsImageRegistrationOptions,
): ProcessRegistration {
    const policy: NewsImagePolicy = policies[style];
    if (
        typeof options.agent !== "object" ||
        options.agent === null ||
        typeof options.agent.compile !== "function"
    ) {
        throw new Error(policy.agentRequiredMessage);
    }
    if (
        typeof options.capability !== "object" ||
        options.capability === null ||
        typeof options.capability.render !== "function"
    ) {
        throw new Error(policy.capabilityRequiredMessage);
    }
    const agent = options.agent;
    const capability = options.capability;
    const compiledSchema = createCompiledSchema(policy);
    const outputSchema = z.strictObject({
        style: z.literal(style),
        image: newsImageSchema,
    });

    return defineProcessRegistration({
        id: policy.id,
        version: "v1",
        inputSchema,
        outputSchema,
        activities: ["news_image_prompt_compilation", "news_image_rendering"],
        execute: async (input, context) => {
            let compiled: z.infer<typeof compiledSchema>;
            let promptModel: string;
            try {
                const compilation = await context.runActivity(
                    "news_image_prompt_compilation",
                    async () => {
                        const result = await agent.compile({
                            title: normalizeWhitespace(input.title),
                            summary: normalizeWhitespace(input.summary),
                            signal: context.signal,
                        });
                        const output = compiledSchema.safeParse(result.output);
                        const model = result.promptModel.trim();
                        if (!output.success || !model || model.length > 200) {
                            throw new Error();
                        }
                        return { output: output.data, promptModel: model };
                    },
                );
                compiled = compilation.output;
                promptModel = compilation.promptModel;
            } catch {
                return failProcess("AGENT_FAILURE", policy.agentFailureMessage);
            }

            try {
                const rendered = await context.runActivity(
                    "news_image_rendering",
                    async () =>
                        capability.render(
                            {
                                prompt: compiled.prompt,
                                aspectRatio: "4:3",
                                style,
                            },
                            {
                                signal: context.signal,
                                idempotencyKey: context.runId,
                            },
                        ),
                );
                context.captureEvaluation({
                    generation: {
                        prompt: compiled.prompt,
                        promptModel,
                        ...rendered.generation,
                    },
                });
                return {
                    style,
                    image: rendered.image,
                };
            } catch (error) {
                if (error instanceof NewsImageRenderingUnavailable) {
                    return failProcess(
                        "DEPENDENCY_FAILURE",
                        "The news image rendering service is unavailable",
                    );
                }
                throw error;
            }
        },
    });
}

function createCompiledSchema(policy: NewsImagePolicy) {
    return z.strictObject({
        newsIdentity: z.string().trim().min(1).max(500),
        coreTension: z.string().trim().min(1).max(500),
        realityAnchor: z.string().trim().min(1).max(500),
        factExclusions: z
            .array(z.string().trim().min(1).max(300))
            .min(1)
            .max(5),
        sceneKernel: z.string().trim().min(1).max(1_000),
        prompt: z
            .string()
            .trim()
            .min(300)
            .max(8_000)
            .refine(policy.hasPromptContract, policy.promptErrorMessage),
    });
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/gu, " ");
}

function findPromptContractEnd(prompt: string): number | undefined {
    const headings = [
        "Use case: stylized-concept",
        "Asset type: horizontal editorial main visual, composed safely for a 4:3 crop",
        "NEWS RELATION:",
        "ONE SCENE KERNEL:",
        "COMPOSITION:",
        "PHYSICAL MAKING RECIPE:",
        "TEXT:",
        "NEGATIVE CONSTRAINTS:",
    ];
    let cursor = -1;
    for (const heading of headings) {
        const next = prompt.indexOf(heading, cursor + 1);
        if (next <= cursor) return undefined;
        cursor = next;
    }
    return cursor + "NEGATIVE CONSTRAINTS:".length;
}

function hasNarrativeMonumentPromptContract(prompt: string): boolean {
    if (findPromptContractEnd(prompt) === undefined) return false;
    return (
        /cobalt-blue/iu.test(prompt) &&
        /warm ivory/iu.test(prompt) &&
        /charcoal/iu.test(prompt) &&
        /old-gold ring/iu.test(prompt) &&
        /exact Chinese title/iu.test(prompt) &&
        /No other words or pseudo-text\./u.test(prompt)
    );
}

function hasPaleWatercolorPromptContract(prompt: string): boolean {
    if (findPromptContractEnd(prompt) === undefined) return false;
    return (
        prompt.includes(
            "No text, letters, numbers, logos or pseudo-text anywhere in the image.",
        ) &&
        /warm old paper/iu.test(prompt) &&
        /pale-cyan/iu.test(prompt) &&
        /gray-green/iu.test(prompt) &&
        /one third/iu.test(prompt) &&
        /cinematic lighting/iu.test(prompt) &&
        /second metaphor/iu.test(prompt)
    );
}

function hasRawHumanismPromptContract(prompt: string): boolean {
    const negativeConstraintsStart = findPromptContractEnd(prompt);
    if (negativeConstraintsStart === undefined) return false;
    const negativeConstraints = prompt.slice(negativeConstraintsStart);
    return (
        prompt.includes(
            "No text, letters, numbers, logos or pseudo-text anywhere in the image.",
        ) &&
        /#141413/iu.test(prompt) &&
        /#FAF9F5/iu.test(prompt) &&
        /60%/u.test(prompt) &&
        /flat/iu.test(prompt) &&
        /\btextures?\b/iu.test(negativeConstraints) &&
        /\bgradients?\b/iu.test(negativeConstraints)
    );
}
