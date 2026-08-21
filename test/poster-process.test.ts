import { describe, expect, it } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import type {
    PosterAgent,
    PosterAgentRequest,
} from "../src/processes/poster/agent.js";
import {
    type PosterRenderingCapability,
    PosterRenderingUnavailable,
} from "../src/processes/poster/capability.js";
import { createPosterRegistration } from "../src/processes/poster/registration.js";

const compiledPoster = {
    prompt: "Create a tall vertical 3:5 poster on warm aged paper with 82% negative space and one small lower-left cluster occupying 15% of the canvas.\n\nUse one torn-paper clipping of a rain-darkened used-bookstore window, softened with grayscale halftone wear and rough fibers.\n\nSet the exact text PIPIPI ZINE in small typewriter letters beside a fully saturated cobalt-blue risograph block covering 2% of the canvas, with ink bleed and slight misregistration.\n\nRender a flat orthographic paper scan with diffuse light and quiet archival memory; avoid full-bleed scenes, advertising, logos, CTA, glossy mockups, cinematic lighting, 3D, neon, cartoons, and dense scrapbooks.",
    recipe: {
        layout: "lower-left-float" as const,
        anchor: "torn-paper clipping" as const,
        typography: "short phrase pressed against image edge" as const,
        accent: "fully saturated cobalt-blue risograph block",
        texture: "halftone degradation" as const,
        mood: "memory" as const,
    },
    interpretation:
        "A rain-darkened bookshop fragment becomes a quiet archival memory.",
};

const posterImage = {
    url: "https://assets.example/posters/poster-1.png",
    contentType: "image/png" as const,
    width: 1_024,
    height: 1_696,
    expiresAt: "2026-08-10T12:00:00.000Z",
};

describe("minimal-zine-poster/v1", () => {
    it("exposes the exact versioned contract through POST /execute", async () => {
        const application = createProcessingApplication({
            executor: createPosterExecutor(
                { compile: async () => compiledPoster },
                { render: async () => posterImage },
            ),
        });
        const { url } = await application.listen();

        try {
            const response = await fetch(`${url}/execute`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    process: "minimal-zine-poster",
                    version: "v1",
                    input: {
                        brief: "A rainy used bookstore",
                        text: "PIPIPI ZINE",
                    },
                }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                process: "minimal-zine-poster",
                version: "v1",
                status: "succeeded",
                output: { ...compiledPoster, image: posterImage },
            });
        } finally {
            await application.close();
        }
    });

    it("compiles the brief, renders once, and returns the structured poster", async () => {
        const agentRequests: PosterAgentRequest[] = [];
        const renderCalls: Array<{
            prompt: string;
            aspectRatio: "3:5";
            idempotencyKey: string;
        }> = [];
        const agent: PosterAgent = {
            compile: async (request) => {
                agentRequests.push(request);
                return compiledPoster;
            },
        };
        const capability: PosterRenderingCapability = {
            render: async (input, options) => {
                renderCalls.push({
                    prompt: input.prompt,
                    aspectRatio: input.aspectRatio,
                    idempotencyKey: options.idempotencyKey,
                });
                return posterImage;
            },
        };
        const executor = createPosterExecutor(agent, capability);

        const result = await executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: {
                brief: "  A rainy   used bookstore  ",
                text: " PIPIPI ZINE ",
            },
        });

        expect(result).toEqual({
            runId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
            process: "minimal-zine-poster",
            version: "v1",
            status: "succeeded",
            output: { ...compiledPoster, image: posterImage },
        });
        expect(agentRequests).toHaveLength(1);
        expect(agentRequests[0]).toMatchObject({
            brief: "A rainy used bookstore",
            text: "PIPIPI ZINE",
        });
        expect(renderCalls).toEqual([
            {
                prompt: compiledPoster.prompt,
                aspectRatio: "3:5",
                idempotencyKey: result.runId,
            },
        ]);
    });

    it("accepts the Skill's hyphenated aged-paper wording", async () => {
        const compiled = {
            ...compiledPoster,
            prompt: compiledPoster.prompt.replace(
                "warm aged paper",
                "warm aged-paper",
            ),
        };
        const executor = createPosterExecutor(
            { compile: async () => compiled },
            { render: async () => posterImage },
        );

        const result = await executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: {
                brief: "A rainy used bookstore",
                text: "PIPIPI ZINE",
            },
        });

        expect(result).toMatchObject({
            status: "succeeded",
            output: { ...compiled, image: posterImage },
        });
    });

    it("rejects caller-supplied implementation mechanics", async () => {
        let agentCalls = 0;
        const executor = createPosterExecutor(
            {
                compile: async () => {
                    agentCalls += 1;
                    return compiledPoster;
                },
            },
            { render: async () => posterImage },
        );

        const result = await executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: {
                brief: "A rainy used bookstore",
                model: "caller-selected-model",
            },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "INVALID_INPUT" },
        });
        expect(agentCalls).toBe(0);
    });

    it("rejects an Agent result that loses required in-image text", async () => {
        let renderCalls = 0;
        const executor = createPosterExecutor(
            {
                compile: async () => ({
                    ...compiledPoster,
                    prompt: compiledPoster.prompt.replace(
                        "PIPIPI ZINE",
                        "DIFFERENT TEXT",
                    ),
                }),
            },
            {
                render: async () => {
                    renderCalls += 1;
                    return posterImage;
                },
            },
        );

        const result = await executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief: "Bookstore", text: "PIPIPI ZINE" },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: {
                code: "AGENT_FAILURE",
                message:
                    "The poster prompt agent could not complete the request",
            },
        });
        expect(renderCalls).toBe(0);
    });

    it("rejects a prompt that does not follow the four-paragraph contract", async () => {
        const executor = createPosterExecutor(
            {
                compile: async () => ({
                    ...compiledPoster,
                    prompt: compiledPoster.prompt.replace(/\n\n/gu, " "),
                }),
            },
            { render: async () => posterImage },
        );

        const result = await executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief: "Bookstore" },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "AGENT_FAILURE" },
        });
    });

    it("rejects a recipe value outside the reviewed Skill axes", async () => {
        const executor = createPosterExecutor(
            {
                compile: async () => ({
                    ...compiledPoster,
                    recipe: {
                        ...compiledPoster.recipe,
                        layout: "commercial-grid",
                    },
                }),
            },
            { render: async () => posterImage },
        );

        const result = await executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief: "Bookstore" },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "AGENT_FAILURE" },
        });
    });

    it("rejects four paragraphs that omit the core visual contract", async () => {
        const executor = createPosterExecutor(
            {
                compile: async () => ({
                    ...compiledPoster,
                    prompt: "Describe a generic poster with enough words to pass the minimum length requirement.\n\nAdd a large product photo and a polished headline.\n\nUse a neutral palette and clean digital shapes.\n\nFinish with dramatic lighting and a glossy mockup.",
                }),
            },
            { render: async () => posterImage },
        );

        const result = await executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief: "Bookstore" },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "AGENT_FAILURE" },
        });
    });

    it("maps a controlled rendering failure to a stable dependency error", async () => {
        const executor = createPosterExecutor(
            { compile: async () => compiledPoster },
            {
                render: async () => {
                    throw new PosterRenderingUnavailable({
                        cause: new Error("private provider detail"),
                    });
                },
            },
        );

        const result = await executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief: "Bookstore" },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: {
                code: "DEPENDENCY_FAILURE",
                message: "The poster rendering service is unavailable",
            },
        });
        expect(JSON.stringify(result)).not.toContain("private provider detail");
    });

    it("maps an invalid Capability result to INVALID_OUTPUT", async () => {
        const executor = createPosterExecutor(
            { compile: async () => compiledPoster },
            {
                render: async () =>
                    ({
                        ...posterImage,
                        url: "file:///private/poster.png",
                    }) as typeof posterImage,
            },
        );

        const result = await executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief: "Bookstore" },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "INVALID_OUTPUT" },
        });
    });

    it("rejects a rendered image outside the 3:5 aspect ratio", async () => {
        const executor = createPosterExecutor(
            { compile: async () => compiledPoster },
            {
                render: async () => ({
                    ...posterImage,
                    width: 1_024,
                    height: 1_024,
                }),
            },
        );

        const result = await executor.execute({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief: "Bookstore" },
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "INVALID_OUTPUT" },
        });
    });

    it("rejects incomplete Registration dependencies during composition", () => {
        expect(() =>
            createPosterExecutor(undefined as unknown as PosterAgent, {
                render: async () => posterImage,
            }),
        ).toThrow("Poster Agent is required");
        expect(() =>
            createPosterExecutor(
                { compile: async () => compiledPoster },
                undefined as unknown as PosterRenderingCapability,
            ),
        ).toThrow("Poster Rendering Capability is required");
    });
});

function createPosterExecutor(
    agent: PosterAgent,
    capability: PosterRenderingCapability,
) {
    return createProcessExecutor({
        registrations: [createPosterRegistration({ agent, capability })],
    });
}
