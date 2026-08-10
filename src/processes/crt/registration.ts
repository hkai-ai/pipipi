import { z } from "zod";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../../process-runtime/index.js";
import type { CrtAgent } from "./agent.js";
import {
    type CrtRenderingCapability,
    CrtRenderingUnavailable,
    crtImageSchema,
    isPublicSourceImageUrl,
} from "./capability.js";
import {
    type CrtAspectRatio,
    type CrtPalette,
    crtAspectRatios,
    crtPaletteNames,
    paletteColors,
    ratioValue,
} from "./style.js";

const inputSchema = z.strictObject({
    sourceImageUrl: z
        .string()
        .trim()
        .min(1)
        .max(2_048)
        .refine(
            isPublicSourceImageUrl,
            "Source image URL must be a public HTTPS URL",
        ),
    palette: z.enum(crtPaletteNames),
    aspectRatio: z.enum(crtAspectRatios),
});

const recipeSchema = z
    .strictObject({
        wallpaperPlacement: z.enum([
            "left-wall",
            "right-wall",
            "upper-crop",
            "lower-rise",
            "diagonal-left",
            "diagonal-right",
        ]),
        crop: z.enum([
            "head-hands",
            "head-shoulders",
            "waist-up",
            "compact-full",
            "profile-mass",
            "object-spread",
        ]),
        subjectCoverage: z.union([z.literal(60), z.literal(70), z.literal(80)]),
        windowCount: z.union([
            z.literal(3),
            z.literal(4),
            z.literal(5),
            z.literal(6),
        ]),
        windowConstellation: z.enum([
            "counter-corners",
            "asymmetric-L",
            "zigzag-cascade",
            "sparse-orbit",
            "split-diagnostic",
            "corner-burst",
            "underlay-cross",
        ]),
        sizeHierarchy: z.enum(["1L+1M+1S", "1L+2M+1S", "1L+1M+3S", "1L+2M+3S"]),
        dominantApplication: z.enum([
            "terminal",
            "files",
            "table",
            "chart",
            "warning",
            "settings",
        ]),
        extractionCount: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        extractionGeometry: z.enum([
            "square+wide",
            "tall+square",
            "wide+tall",
            "square+wide+tall",
        ]),
        cartoonTreatment: z.enum([
            "block-caricature",
            "terminal-mascot",
            "symbolic-cutout",
            "minimalist-geometric-pop-art",
        ]),
        caricatureMutation: z.enum([
            "oversized-feature+compressed-body",
            "facial-spacing+silhouette-skew",
            "blocky-limbs+awkward-pose",
            "amplified-accessory+object-scale",
            "mascot-collapse+comic-ugliness",
        ]),
        midtoneMap: z.enum([
            "face-side+garment",
            "hair-underplane+limb",
            "torso+hands",
            "back-plane+accessory",
            "distributed-large-planes",
        ]),
        polarity: z.enum(["light-field", "dark-field", "split-local-fields"]),
        signalEmphasis: z.enum([
            "persistence",
            "row-jitter",
            "sync-band",
            "edge-noise",
            "pixel-misregistration",
        ]),
    })
    .refine(isCompatibleRecipe, "CRT recipe axes are incompatible");

const compiledSchema = z.strictObject({
    prompt: z
        .string()
        .trim()
        .min(400)
        .max(12_000)
        .refine(hasFourParagraphs, "CRT prompt must have four paragraphs")
        .refine(
            hasCoreVisualRules,
            "CRT prompt must preserve the visual contract",
        ),
    recipe: recipeSchema,
});

const agentCompileAttempts = 2;

const outputSchema = z
    .strictObject({
        aspectRatio: z.enum(crtAspectRatios),
        image: crtImageSchema,
    })
    .superRefine((output, context) => {
        if (
            Math.abs(
                output.image.width / output.image.height -
                    ratioValue(output.aspectRatio),
            ) > 0.015
        ) {
            context.addIssue({
                code: "custom",
                message: "CRT image must match its requested aspect ratio",
            });
        }
    });

type RegistrationOptions = {
    agent: CrtAgent;
    capability: CrtRenderingCapability;
};

export function createCrtRegistration(
    options: RegistrationOptions,
): ProcessRegistration {
    if (
        typeof options.agent !== "object" ||
        options.agent === null ||
        typeof options.agent.compile !== "function"
    ) {
        throw new Error("CRT Agent is required");
    }
    if (
        typeof options.capability !== "object" ||
        options.capability === null ||
        typeof options.capability.transform !== "function"
    ) {
        throw new Error("CRT Rendering Capability is required");
    }
    const agent = options.agent;
    const capability = options.capability;

    return defineProcessRegistration({
        id: "crt-interface-image",
        version: "v1",
        inputSchema,
        outputSchema,
        activities: ["crt_prompt_compilation", "crt_rendering"],
        execute: async (input, context) => {
            let compiled: z.infer<typeof compiledSchema>;
            try {
                compiled = await context.runActivity(
                    "crt_prompt_compilation",
                    async () => {
                        const result = await compileAgentResult(
                            agent,
                            input,
                            context.signal,
                        );
                        if (!result) throw new CrtPromptActivityFailure();
                        return result;
                    },
                );
            } catch {
                return agentFailure();
            }

            try {
                const image = await context.runActivity(
                    "crt_rendering",
                    async () =>
                        capability.transform(
                            {
                                sourceImageUrl: input.sourceImageUrl,
                                prompt: compiled.prompt,
                                palette: input.palette,
                                aspectRatio: input.aspectRatio,
                            },
                            {
                                signal: context.signal,
                                idempotencyKey: context.runId,
                            },
                        ),
                );
                return { aspectRatio: input.aspectRatio, image };
            } catch (error) {
                if (error instanceof CrtRenderingUnavailable) {
                    return failProcess(
                        "DEPENDENCY_FAILURE",
                        "The CRT rendering service is unavailable",
                    );
                }
                throw error;
            }
        },
    });
}

class CrtPromptActivityFailure extends Error {}

async function compileAgentResult(
    agent: CrtAgent,
    input: z.infer<typeof inputSchema>,
    signal: AbortSignal,
): Promise<z.infer<typeof compiledSchema> | undefined> {
    for (let attempt = 0; attempt < agentCompileAttempts; attempt += 1) {
        try {
            const result = compiledSchema.safeParse(
                await agent.compile({
                    palette: input.palette,
                    aspectRatio: input.aspectRatio,
                    signal,
                }),
            );
            if (
                result.success &&
                matchesRequest(
                    result.data.prompt,
                    input.palette,
                    input.aspectRatio,
                )
            ) {
                return result.data;
            }
        } catch {
            // The Agent has no side effects, so one malformed response is safe
            // to retry before any rendering call can occur.
        }
        if (signal.aborted) return undefined;
    }
    return undefined;
}

type RecipeCompatibility = {
    subjectCoverage: 60 | 70 | 80;
    windowCount: 3 | 4 | 5 | 6;
    extractionCount: 1 | 2 | 3;
    extractionGeometry:
        | "square+wide"
        | "tall+square"
        | "wide+tall"
        | "square+wide+tall";
};

function isCompatibleRecipe(recipe: RecipeCompatibility): boolean {
    if (recipe.subjectCoverage === 80 && recipe.windowCount > 4) return false;
    if (recipe.windowCount === 6 && recipe.subjectCoverage > 70) return false;
    if (recipe.extractionCount === 2 && recipe.windowCount < 4) return false;
    if (recipe.extractionCount === 3) {
        return (
            recipe.windowCount >= 5 &&
            recipe.extractionGeometry === "square+wide+tall"
        );
    }
    return recipe.extractionGeometry !== "square+wide+tall";
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
        /source image/iu.test(value) &&
        /(?:roster|prominent|interacting)/iu.test(value) &&
        /(?:5[-– ]9|five[- ]to[- ]nine).{0,40}(?:mass|shape)/iu.test(value) &&
        /20%[-– ]30%|20% to 30%|(?:2\d|30)%[^.\n]{0,30}connected open field/iu.test(
            value,
        ) &&
        /French/iu.test(value) &&
        /exactly one cursor/iu.test(value) &&
        /tait-crt-interface-skill/u.test(value) &&
        /checkerboard/iu.test(value) &&
        /(?:shared|global).{0,30}(?:grid|lattice|cell)/iu.test(value) &&
        /outer 10%/iu.test(value) &&
        /barrel/iu.test(value) &&
        /(?:avoid|exclude|show no|do not (?:show|include|use))/iu.test(value)
    );
}

function matchesRequest(
    prompt: string,
    palette: CrtPalette,
    aspectRatio: CrtAspectRatio,
): boolean {
    if (!prompt.includes(aspectRatio)) return false;
    const colors = paletteColors(palette);
    if (colors) {
        const normalized = prompt.toLowerCase();
        return colors.every((color) => normalized.includes(color));
    }
    return (
        /source image/iu.test(prompt) &&
        /(?:2[-– ]5|two[- ]to[- ]five).{0,30}(?:color|colour)/iu.test(prompt)
    );
}

function agentFailure() {
    return failProcess(
        "AGENT_FAILURE",
        "The CRT prompt agent could not complete the request",
    );
}
