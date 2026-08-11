import { describe, expect, it } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import type { ContentProcessingCapability } from "../src/processes/content/capability.js";
import type { CrtAgent, CrtAgentRequest } from "../src/processes/crt/agent.js";
import {
    type CrtRenderingCapability,
    CrtRenderingUnavailable,
} from "../src/processes/crt/capability.js";

const unusedContent: ContentProcessingCapability = {
    process: async () => {
        throw new Error("Content processing should not run");
    },
};

const recipe = {
    wallpaperPlacement: "diagonal-left" as const,
    crop: "waist-up" as const,
    subjectCoverage: 70 as const,
    windowCount: 4 as const,
    windowConstellation: "asymmetric-L" as const,
    sizeHierarchy: "1L+2M+1S" as const,
    dominantApplication: "table" as const,
    extractionCount: 2 as const,
    extractionGeometry: "square+wide" as const,
    cartoonTreatment: "terminal-mascot" as const,
    caricatureMutation: "facial-spacing+silhouette-skew" as const,
    midtoneMap: "face-side+garment" as const,
    polarity: "dark-field" as const,
    signalEmphasis: "row-jitter" as const,
};

const compiledCrt = {
    prompt: crtPrompt("经典", "4:3"),
    recipe,
};

const crtImage = {
    url: "https://assets.example/crt/run-1.png",
    contentType: "image/png" as const,
    width: 1_600,
    height: 1_200,
    expiresAt: "2026-08-10T12:00:00.000Z",
};

const crtRawImage = {
    url: "https://assets.example/crt/raw/run-1.png",
    contentType: "image/png" as const,
    width: 1_600,
    height: 1_200,
};

const rendered = { image: crtImage, rawImage: crtRawImage };

describe("crt-interface-image/v1", () => {
    it("exposes the exact versioned contract through POST /execute", async () => {
        const application = createProcessingApplication({
            executor: createCrtExecutor(
                { compile: async () => compiledCrt },
                { transform: async () => rendered },
            ),
        });
        const { url } = await application.listen();

        try {
            const response = await fetch(`${url}/execute`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    process: "crt-interface-image",
                    version: "v1",
                    input: {
                        sourceImageUrl:
                            "https://images.example.com/portrait-01.png",
                        palette: "经典",
                        aspectRatio: "4:3",
                    },
                }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                process: "crt-interface-image",
                version: "v1",
                status: "succeeded",
                output: { aspectRatio: "4:3", image: crtImage },
            });
        } finally {
            await application.close();
        }
    });

    it("compiles without exposing the source asset, transforms once, and returns no prompt", async () => {
        const agentRequests: CrtAgentRequest[] = [];
        const transformCalls: Array<{
            sourceImageUrl: string;
            prompt: string;
            palette: string;
            aspectRatio: string;
            idempotencyKey: string;
        }> = [];
        const agent: CrtAgent = {
            compile: async (request) => {
                agentRequests.push(request);
                return compiledCrt;
            },
        };
        const capability: CrtRenderingCapability = {
            transform: async (input, options) => {
                transformCalls.push({
                    ...input,
                    idempotencyKey: options.idempotencyKey,
                });
                return rendered;
            },
        };
        const executor = createCrtExecutor(agent, capability);

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toEqual({
            runId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
            process: "crt-interface-image",
            version: "v1",
            status: "succeeded",
            output: {
                aspectRatio: "4:3",
                image: crtImage,
                rawImage: crtRawImage,
            },
        });
        expect(agentRequests).toHaveLength(1);
        expect(agentRequests[0]).toMatchObject({
            palette: "经典",
            aspectRatio: "4:3",
        });
        expect(agentRequests[0]).not.toHaveProperty("sourceImageUrl");
        expect(transformCalls).toEqual([
            {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                prompt: compiledCrt.prompt,
                palette: "经典",
                aspectRatio: "4:3",
                grain: "normal",
                idempotencyKey: result.runId,
            },
        ]);
        expect(JSON.stringify(result)).not.toContain("prompt");
        expect(JSON.stringify(result)).not.toContain("recipe");
    });

    it("retries one malformed Agent response before rendering once", async () => {
        let agentCalls = 0;
        let transformCalls = 0;
        const executor = createCrtExecutor(
            {
                compile: async () => {
                    agentCalls += 1;
                    if (agentCalls === 1) {
                        throw new SyntaxError("malformed Agent JSON");
                    }
                    return compiledCrt;
                },
            },
            {
                transform: async () => {
                    transformCalls += 1;
                    return rendered;
                },
            },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toMatchObject({ status: "succeeded" });
        expect(agentCalls).toBe(2);
        expect(transformCalls).toBe(1);
    });

    it("accepts a concrete 30% connected open-field instruction", async () => {
        const executor = createCrtExecutor(
            {
                compile: async () => ({
                    ...compiledCrt,
                    prompt: compiledCrt.prompt.replace(
                        "20%-30% connected open field",
                        "30% connected open field",
                    ),
                }),
            },
            { transform: async () => rendered },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toMatchObject({ status: "succeeded" });
    });

    it("accepts equivalent source-image and exclusion wording", async () => {
        const executor = createCrtExecutor(
            {
                compile: async () => ({
                    ...compiledCrt,
                    prompt: compiledCrt.prompt
                        .replace(
                            "attached source image",
                            "provided source image",
                        )
                        .replace("Avoid tracing", "Exclude tracing"),
                }),
            },
            { transform: async () => rendered },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toMatchObject({ status: "succeeded" });
    });

    it("accepts the source-derived palette contract", async () => {
        const executor = createCrtExecutor(
            {
                compile: async () => ({
                    prompt: crtPrompt("如图", "9:16"),
                    recipe,
                }),
            },
            {
                transform: async () => ({
                    ...rendered,
                    image: { ...crtImage, width: 1_152, height: 2_048 },
                }),
            },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/group-02.png",
                palette: "如图",
                aspectRatio: "9:16",
            },
        });

        expect(result).toMatchObject({
            status: "succeeded",
            output: {
                aspectRatio: "9:16",
                image: { width: 1_152, height: 2_048 },
            },
        });
    });

    it("rejects caller-supplied implementation mechanics", async () => {
        let agentCalls = 0;
        const executor = createCrtExecutor(
            {
                compile: async () => {
                    agentCalls += 1;
                    return compiledCrt;
                },
            },
            { transform: async () => rendered },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
                model: "gpt-image-2",
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "INVALID_INPUT" },
        });
        expect(agentCalls).toBe(0);
    });

    it.each([
        ["plain HTTP URL", "http://assets.example/source.png"],
        ["loopback URL", "https://localhost/source.png"],
        ["IP literal URL", "https://127.0.0.1/source.png"],
        ["data URL", "data:image/png;base64,AAAA"],
        ["local path", "/tmp/source.png"],
    ])("rejects an unsafe %s", async (_case, sourceImageUrl) => {
        let agentCalls = 0;
        const executor = createCrtExecutor(
            {
                compile: async () => {
                    agentCalls += 1;
                    return compiledCrt;
                },
            },
            { transform: async () => rendered },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl,
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "INVALID_INPUT" },
        });
        expect(agentCalls).toBe(0);
    });

    it("rejects an invalid prompt before the image Capability runs", async () => {
        let transformCalls = 0;
        const executor = createCrtExecutor(
            {
                compile: async () => ({
                    ...compiledCrt,
                    prompt: compiledCrt.prompt.replace(
                        "tait-crt-interface-skill",
                        "different-signature",
                    ),
                }),
            },
            {
                transform: async () => {
                    transformCalls += 1;
                    return rendered;
                },
            },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "AGENT_FAILURE" },
        });
        expect(transformCalls).toBe(0);
    });

    it("rejects an incompatible variation recipe", async () => {
        const executor = createCrtExecutor(
            {
                compile: async () => ({
                    ...compiledCrt,
                    recipe: {
                        ...recipe,
                        subjectCoverage: 80,
                        windowCount: 6,
                    },
                }),
            },
            { transform: async () => rendered },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "AGENT_FAILURE" },
        });
    });

    it("defaults the grain, forwards it to the Capability, and hides it from the Agent", async () => {
        const agentRequests: unknown[] = [];
        const transformCalls: Array<Record<string, unknown>> = [];
        const executor = createCrtExecutor(
            {
                compile: async (request) => {
                    agentRequests.push(request);
                    return compiledCrt;
                },
            },
            {
                transform: async (input) => {
                    transformCalls.push({ ...input });
                    return rendered;
                },
            },
        );

        const omitted = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });
        const explicit = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
                grain: "coarse",
            },
        });

        expect(omitted).toMatchObject({ status: "succeeded" });
        expect(explicit).toMatchObject({ status: "succeeded" });
        expect(transformCalls.map((call) => call.grain)).toEqual([
            "normal",
            "coarse",
        ]);
        for (const request of agentRequests) {
            expect(request).not.toHaveProperty("grain");
        }
    });

    it("rejects an unknown grain before calling the Agent or the Capability", async () => {
        let agentCalls = 0;
        let transformCalls = 0;
        const executor = createCrtExecutor(
            {
                compile: async () => {
                    agentCalls += 1;
                    return compiledCrt;
                },
            },
            {
                transform: async () => {
                    transformCalls += 1;
                    return rendered;
                },
            },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
                grain: "extra-coarse",
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "INVALID_INPUT" },
        });
        expect(agentCalls).toBe(0);
        expect(transformCalls).toBe(0);
    });

    it("maps a controlled rendering failure to a stable dependency error", async () => {
        const executor = createCrtExecutor(
            { compile: async () => compiledCrt },
            {
                transform: async () => {
                    throw new CrtRenderingUnavailable({
                        cause: new Error("private provider detail"),
                    });
                },
            },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: {
                code: "DEPENDENCY_FAILURE",
                message: "The CRT rendering service is unavailable",
            },
        });
        expect(JSON.stringify(result)).not.toContain("private provider detail");
    });

    it("maps a failure after the edit was charged to a separate public code", async () => {
        const executor = createCrtExecutor(
            { compile: async () => compiledCrt },
            {
                transform: async () => {
                    throw new CrtRenderingUnavailable({
                        committed: true,
                        cause: new Error("private storage detail"),
                    });
                },
            },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: {
                code: "DEPENDENCY_FAILURE_AFTER_COMMIT",
                message:
                    "The CRT image was rendered but could not be delivered",
            },
        });
        expect(JSON.stringify(result)).not.toContain("private storage detail");
    });

    it("maps malformed or wrong-ratio Capability output to INVALID_OUTPUT", async () => {
        const unsafeExecutor = createCrtExecutor(
            { compile: async () => compiledCrt },
            {
                transform: async () =>
                    ({
                        ...rendered,
                        image: {
                            ...crtImage,
                            url: "file:///private/crt.png",
                        },
                    }) as typeof rendered,
            },
        );
        const wrongRatioExecutor = createCrtExecutor(
            { compile: async () => compiledCrt },
            {
                transform: async () => ({
                    ...rendered,
                    image: { ...crtImage, width: 1_024, height: 1_024 },
                }),
            },
        );
        const input = {
            sourceImageUrl: "https://images.example.com/portrait-01.png",
            palette: "经典",
            aspectRatio: "4:3",
        };

        const [unsafe, wrongRatio] = await Promise.all([
            unsafeExecutor.execute({
                process: "crt-interface-image",
                version: "v1",
                input,
            }),
            wrongRatioExecutor.execute({
                process: "crt-interface-image",
                version: "v1",
                input,
            }),
        ]);

        expect(unsafe).toMatchObject({
            status: "failed",
            error: { code: "INVALID_OUTPUT" },
        });
        expect(wrongRatio).toMatchObject({
            status: "failed",
            error: { code: "INVALID_OUTPUT" },
        });
    });

    it("converts unexpected dependency exceptions to INTERNAL_ERROR", async () => {
        const executor = createCrtExecutor(
            { compile: async () => compiledCrt },
            {
                transform: async () => {
                    throw new Error("unexpected private detail");
                },
            },
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "INTERNAL_ERROR" },
        });
        expect(JSON.stringify(result)).not.toContain(
            "unexpected private detail",
        );
    });

    it("aborts the request-local Agent when the Process times out", async () => {
        let aborted = false;
        const executor = createCrtExecutor(
            {
                compile: (request) =>
                    new Promise((_resolve, reject) => {
                        request.signal.addEventListener(
                            "abort",
                            () => {
                                aborted = true;
                                reject(new Error("aborted"));
                            },
                            { once: true },
                        );
                    }),
            },
            { transform: async () => rendered },
            5,
        );

        const result = await executor.execute({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                palette: "经典",
                aspectRatio: "4:3",
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "PROCESS_TIMEOUT" },
        });
        expect(aborted).toBe(true);
    });
});

function createCrtExecutor(
    agent: CrtAgent,
    capability: CrtRenderingCapability,
    processTimeoutMs = 1_000,
) {
    return createProcessExecutor({
        contentProcessing: unusedContent,
        crt: { agent, capability },
        processTimeoutMs,
    });
}

function crtPrompt(palette: "经典" | "如图", aspectRatio: "4:3" | "9:16") {
    const paletteInstruction =
        palette === "经典"
            ? "Use only the 经典 palette #dee4e0 and #2e382d."
            : "Derive a coherent two-to-five color palette from the attached source image and use no other colors.";
    return `Transform the attached source image into one ${aspectRatio} CRT wallpaper composition. Lock a roster of every prominent or interacting subject, preserve their order and relationships, retain only a few identity anchors, sever the source contours, alter at least three structural relationships, and rebuild them from five-to-nine flat interlocking masses with plausible blocky hands. Use the diagonal-left waist-up recipe at 70% subject coverage so the subject stays dominant and independently authored.\n\nPlace four foreground windows in an asymmetric-L constellation with one large, two medium, and one small tier, using 5%-20% staggered overlap and preserving 20%-30% connected open field. Include two unequal feature crops, a full-width menu, one open French drop-down, exactly one cursor, and the exact lowercase signature tait-crt-interface-skill unobscured in the upper-right title bar.\n\n${paletteInstruction} Use a dark-field polarity with broad face-side and garment midtones. Build the subject, windows, borders, glyphs, icons, cursor, charts, accents, and a regular darkest/lightest checkerboard on one shared global square-cell lattice; keep all steps integer-aligned and free from antialiasing or smooth sub-cell transitions.\n\nApply dense palette-bound scanlines, sparse noise, hard-cell bloom, one-cell misregistration, short persistence, and restrained row jitter. Force unmistakable radial barrel curvature throughout the outer 10% of all four sides while keeping the inner 80% stable. Avoid tracing, filtered photography, duplicate subjects, malformed hands, invented colors, gradients, modern cards, vector smoothness, 3D, a physical monitor, other logos, calls to action, and long text.`;
}
