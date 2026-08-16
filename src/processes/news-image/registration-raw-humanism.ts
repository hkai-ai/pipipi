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
    newsImageSchema,
} from "./capability.js";

const inputSchema = z.strictObject({
    title: z.string().trim().min(1).max(300),
    summary: z.string().trim().min(1).max(12_000),
});

const compiledSchema = z.strictObject({
    newsIdentity: z.string().trim().min(1).max(500),
    coreTension: z.string().trim().min(1).max(500),
    realityAnchor: z.string().trim().min(1).max(500),
    factExclusions: z.array(z.string().trim().min(1).max(300)).min(1).max(5),
    sceneKernel: z.string().trim().min(1).max(1_000),
    prompt: z
        .string()
        .trim()
        .min(300)
        .max(8_000)
        .refine(hasPromptContract, "Raw humanism prompt contract is invalid"),
});

const outputSchema = z.strictObject({
    style: z.literal("raw-humanism"),
    image: newsImageSchema,
});

export function createRawHumanismRegistration(options: {
    agent: NewsImageAgent;
    capability: NewsImageRenderingCapability;
}): ProcessRegistration {
    const { agent, capability } = options;
    if (!agent?.compile)
        throw new Error("Raw Humanism News Image Agent is required");
    if (!capability?.render)
        throw new Error("Raw Humanism Rendering Capability is required");

    return defineProcessRegistration({
        id: "news-image-raw-humanism",
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
                            title: normalize(input.title),
                            summary: normalize(input.summary),
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
                return failProcess(
                    "AGENT_FAILURE",
                    "The raw humanism prompt agent could not complete the request",
                );
            }

            try {
                const rendered = await context.runActivity(
                    "news_image_rendering",
                    async () =>
                        capability.render(
                            {
                                prompt: compiled.prompt,
                                aspectRatio: "4:3",
                                style: "raw-humanism",
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
                    style: "raw-humanism" as const,
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

function normalize(value: string): string {
    return value.replace(/\s+/gu, " ");
}

function hasPromptContract(prompt: string): boolean {
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
        if (next <= cursor) return false;
        cursor = next;
    }
    const negativeConstraints = prompt.slice(
        cursor + "NEGATIVE CONSTRAINTS:".length,
    );
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
