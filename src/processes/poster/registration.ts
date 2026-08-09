import { z } from "zod";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../runtime/index.js";
import type { PosterAgent } from "./agent.js";
import {
    type PosterRenderingCapability,
    PosterRenderingUnavailable,
    posterImageSchema,
} from "./capability.js";

const inputSchema = z.strictObject({
    brief: z.string().trim().min(1).max(12_000),
    text: z.string().trim().min(1).max(80).optional(),
});

const recipeSchema = z.strictObject({
    layout: z.enum([
        "center-fragment",
        "lower-left-float",
        "upper-right-block",
        "dual-panel",
        "irregular-cutout",
        "type-led",
        "dot-orbit",
        "single-specimen",
    ]),
    anchor: z.enum([
        "tiny faded photo",
        "torn-paper clipping",
        "flat silhouette",
        "solid color block",
        "old printed illustration",
        "object specimen",
        "translucent geometric overlay",
        "abstract texture window",
    ]),
    typography: z.enum([
        "fragmented floating letters",
        "short phrase pressed against image edge",
        "archive microtext with date/weather",
        "diagonal scattered words",
        "low-contrast gray ghost text",
        "headline-as-object with rough letterpress",
        "text inside a color block or cutout",
        "almost textless, only a tiny caption",
    ]),
    accent: z
        .string()
        .trim()
        .min(3)
        .max(160)
        .refine(
            (value) =>
                /saturated|high-chroma|opaque|vivid|clean/iu.test(value) &&
                /cobalt|ultramarine|cyan|violet|magenta|yellow|green|orange|red/iu.test(
                    value,
                ),
            "Poster accent must name one high-chroma color",
        ),
    texture: z.enum([
        "xerox softness",
        "risograph grain",
        "letterpress ink bleed",
        "halftone degradation",
        "film grain photo",
        "scan noise and paper fibers",
        "aged paper mottling",
        "soft motion blur on selected text",
    ]),
    mood: z.enum([
        "quiet",
        "summer",
        "solitude",
        "childhood",
        "seaside",
        "afternoon",
        "night",
        "memory",
        "slight surrealism",
    ]),
});

const compiledSchema = z.strictObject({
    prompt: z
        .string()
        .trim()
        .min(80)
        .max(12_000)
        .refine(hasFourParagraphs, "Poster prompt must have four paragraphs")
        .refine(
            hasCoreVisualRules,
            "Poster prompt must preserve the reviewed visual contract",
        ),
    recipe: recipeSchema,
    interpretation: z.string().trim().min(1).max(500),
});

const outputSchema = compiledSchema
    .extend({ image: posterImageSchema })
    .refine(
        (output) =>
            Math.abs(output.image.width / output.image.height - 3 / 5) < 0.03,
        "Poster image must keep the 3:5 aspect ratio",
    );

type RegistrationOptions = {
    agent: PosterAgent;
    capability: PosterRenderingCapability;
};

export function createPosterRegistration(
    options: RegistrationOptions,
): ProcessRegistration {
    if (
        typeof options.agent !== "object" ||
        options.agent === null ||
        typeof options.agent.compile !== "function"
    ) {
        throw new Error("Poster Agent is required");
    }
    if (
        typeof options.capability !== "object" ||
        options.capability === null ||
        typeof options.capability.render !== "function"
    ) {
        throw new Error("Poster Rendering Capability is required");
    }
    const agent = options.agent;
    const capability = options.capability;

    return defineProcessRegistration({
        id: "minimal-zine-poster",
        version: "v1",
        inputSchema,
        outputSchema,
        execute: async (input, context) => {
            const brief = normalizeWhitespace(input.brief);
            const text = input.text;

            let compiled: z.infer<typeof compiledSchema>;
            try {
                const result = compiledSchema.safeParse(
                    await agent.compile({
                        brief,
                        ...(text ? { text } : {}),
                        signal: context.signal,
                    }),
                );
                if (
                    !result.success ||
                    (text !== undefined && !result.data.prompt.includes(text))
                ) {
                    return agentFailure();
                }
                compiled = result.data;
            } catch {
                return agentFailure();
            }

            try {
                const image = await capability.render(
                    { prompt: compiled.prompt, aspectRatio: "3:5" },
                    {
                        signal: context.signal,
                        idempotencyKey: context.runId,
                    },
                );
                return { ...compiled, image };
            } catch (error) {
                if (error instanceof PosterRenderingUnavailable) {
                    return failProcess(
                        "DEPENDENCY_FAILURE",
                        "The poster rendering service is unavailable",
                    );
                }
                throw error;
            }
        },
    });
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ");
}

function hasFourParagraphs(value: string): boolean {
    return (
        value
            .split(/\n\s*\n/u)
            .map((part) => part.trim())
            .filter(Boolean).length === 4
    );
}

function hasCoreVisualRules(value: string): boolean {
    return (
        /3:5/u.test(value) &&
        /(?:7\d|8\d|90)%/u.test(value) &&
        /negative space/iu.test(value) &&
        /aged[- ]paper|old[- ]paper|paper canvas/iu.test(value) &&
        /saturated|high-chroma|opaque|vivid|clean/iu.test(value) &&
        /cobalt|ultramarine|cyan|violet|magenta|yellow|green|orange|red/iu.test(
            value,
        ) &&
        /scan/iu.test(value) &&
        /avoid/iu.test(value)
    );
}

function agentFailure() {
    return failProcess(
        "AGENT_FAILURE",
        "The poster prompt agent could not complete the request",
    );
}
