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
        .refine(hasPromptContract, "Narrative monument prompt is invalid"),
});

const outputSchema = z.strictObject({
    style: z.literal("narrative-monument"),
    image: newsImageSchema,
});

export function createNarrativeMonumentRegistration(options: {
    agent: NewsImageAgent;
    capability: NewsImageRenderingCapability;
}): ProcessRegistration {
    const { agent, capability } = options;
    if (!agent?.compile)
        throw new Error("Narrative Monument Agent is required");
    if (!capability?.render)
        throw new Error("Narrative Monument Rendering Capability is required");

    return defineProcessRegistration({
        id: "news-image-narrative-monument",
        version: "v1",
        inputSchema,
        outputSchema,
        activities: ["news_image_prompt_compilation", "news_image_rendering"],
        execute: async (input, context) => {
            let compiled: z.infer<typeof compiledSchema>;
            try {
                compiled = await context.runActivity(
                    "news_image_prompt_compilation",
                    async () => {
                        const result = compiledSchema.safeParse(
                            await agent.compile({
                                title: normalize(input.title),
                                summary: normalize(input.summary),
                                signal: context.signal,
                            }),
                        );
                        if (!result.success) throw new Error();
                        return result.data;
                    },
                );
            } catch {
                return failProcess(
                    "AGENT_FAILURE",
                    "The narrative monument prompt agent could not complete the request",
                );
            }

            try {
                const image = await context.runActivity(
                    "news_image_rendering",
                    async () =>
                        capability.render(
                            {
                                prompt: compiled.prompt,
                                aspectRatio: "4:3",
                                style: "narrative-monument",
                            },
                            {
                                signal: context.signal,
                                idempotencyKey: context.runId,
                            },
                        ),
                );
                return { style: "narrative-monument" as const, image };
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
    return (
        /cobalt-blue/iu.test(prompt) &&
        /warm ivory/iu.test(prompt) &&
        /charcoal/iu.test(prompt) &&
        /old-gold ring/iu.test(prompt) &&
        /exact Chinese title/iu.test(prompt) &&
        /No other words or pseudo-text\./u.test(prompt)
    );
}
