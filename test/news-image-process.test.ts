import { describe, expect, it } from "vitest";
import { createProcessExecutor } from "../src/processes/catalog.js";
import type { ContentProcessingCapability } from "../src/processes/content/capability.js";
import type {
    NewsImageAgent,
    NewsImageAgentRequest,
} from "../src/processes/news-image/agent.js";
import {
    type NewsImageRenderingCapability,
    NewsImageRenderingUnavailable,
} from "../src/processes/news-image/capability.js";

type Style = "narrative-monument" | "pale-watercolor" | "raw-humanism";

const cases = [
    {
        style: "narrative-monument",
        otherStyle: "pale-watercolor",
        process: "news-image-narrative-monument",
    },
    {
        style: "pale-watercolor",
        otherStyle: "raw-humanism",
        process: "news-image-pale-watercolor",
    },
    {
        style: "raw-humanism",
        otherStyle: "narrative-monument",
        process: "news-image-raw-humanism",
    },
] as const;

const unusedContent: ContentProcessingCapability = {
    process: async () => {
        throw new Error("Content processing should not run");
    },
};

const image = {
    url: "https://assets.example/news/run-1.png",
    contentType: "image/png" as const,
    width: 1_600,
    height: 1_200,
};

const generation = {
    imageProvider: "test-provider",
    imageModel: "test-image-model",
    aspectRatio: "4:3" as const,
    width: 1_600 as const,
    height: 1_200 as const,
    quality: "low" as const,
    outputFormat: "png" as const,
    numImages: 1 as const,
    seed: null,
    otherParams: {},
};

describe("news image Business Processes", () => {
    it.each(cases)(
        "$process/v1 normalizes input, renders its fixed style once, and hides implementation output",
        async ({ process, style }) => {
            const agentRequests: NewsImageAgentRequest[] = [];
            const renderCalls: Array<{
                prompt: string;
                aspectRatio: "4:3";
                style: Style;
                idempotencyKey: string;
            }> = [];
            const compiled = compilation(style);
            const agent: NewsImageAgent = {
                compile: async (request) => {
                    agentRequests.push(request);
                    return { output: compiled, promptModel: "test-text-model" };
                },
            };
            const capability: NewsImageRenderingCapability = {
                render: async (input, options) => {
                    renderCalls.push({
                        ...input,
                        idempotencyKey: options.idempotencyKey,
                    });
                    return { image, generation };
                },
            };
            const executor = createNewsImageExecutor(style, agent, capability);

            const result = await executor.execute({
                process,
                version: "v1",
                input: {
                    title: "  城市   更新计划启动  ",
                    summary: "  旧街区将分阶段   改造并保留公共空间。 ",
                },
            });

            expect(result).toEqual({
                runId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
                process,
                version: "v1",
                status: "succeeded",
                output: { style, image },
            });
            expect(agentRequests).toHaveLength(1);
            expect(agentRequests[0]).toMatchObject({
                title: "城市 更新计划启动",
                summary: "旧街区将分阶段 改造并保留公共空间。",
            });
            expect(renderCalls).toEqual([
                {
                    prompt: compiled.prompt,
                    aspectRatio: "4:3",
                    style,
                    idempotencyKey: result.runId,
                },
            ]);
            if (result.status !== "succeeded") {
                throw new Error("News image Process did not succeed");
            }
            expect(result.output).not.toHaveProperty("prompt");
            expect(result.output).not.toHaveProperty("generation");
            expect(result.output).not.toHaveProperty("promptModel");
        },
    );

    it.each(cases)(
        "$process/v1 rejects invalid Agent output before rendering",
        async ({ process, style }) => {
            let renderCalls = 0;
            const executor = createNewsImageExecutor(
                style,
                {
                    compile: async () => ({
                        output: { ...compilation(style), prompt: "too short" },
                        promptModel: "test-text-model",
                    }),
                },
                {
                    render: async () => {
                        renderCalls += 1;
                        return { image, generation };
                    },
                },
            );

            const result = await executor.execute({
                process,
                version: "v1",
                input: { title: "城市更新", summary: "公共空间分阶段改造。" },
            });

            expect(result).toMatchObject({
                process,
                version: "v1",
                status: "failed",
                error: { code: "AGENT_FAILURE" },
            });
            expect(renderCalls).toBe(0);
        },
    );

    it.each(cases)(
        "$process/v1 rejects a prompt compiled for another fixed style",
        async ({ process, style, otherStyle }) => {
            let renderCalls = 0;
            const executor = createNewsImageExecutor(
                style,
                {
                    compile: async () => ({
                        output: compilation(otherStyle),
                        promptModel: "test-text-model",
                    }),
                },
                {
                    render: async () => {
                        renderCalls += 1;
                        return { image, generation };
                    },
                },
            );

            const result = await executor.execute({
                process,
                version: "v1",
                input: { title: "城市更新", summary: "公共空间分阶段改造。" },
            });

            expect(result).toMatchObject({
                process,
                version: "v1",
                status: "failed",
                error: { code: "AGENT_FAILURE" },
            });
            expect(renderCalls).toBe(0);
        },
    );

    it.each(cases)(
        "$process/v1 maps rendering unavailability to a stable dependency error",
        async ({ process, style }) => {
            const executor = createNewsImageExecutor(
                style,
                {
                    compile: async () => ({
                        output: compilation(style),
                        promptModel: "test-text-model",
                    }),
                },
                {
                    render: async () => {
                        throw new NewsImageRenderingUnavailable();
                    },
                },
            );

            const result = await executor.execute({
                process,
                version: "v1",
                input: { title: "城市更新", summary: "公共空间分阶段改造。" },
            });

            expect(result).toMatchObject({
                process,
                version: "v1",
                status: "failed",
                error: { code: "DEPENDENCY_FAILURE" },
            });
        },
    );
});

function createNewsImageExecutor(
    style: Style,
    agent: NewsImageAgent,
    capability: NewsImageRenderingCapability,
) {
    const binding = { agent, capability };
    return createProcessExecutor({
        contentProcessing: unusedContent,
        ...(style === "narrative-monument"
            ? { narrativeMonument: binding }
            : style === "pale-watercolor"
              ? { paleWatercolor: binding }
              : { rawHumanism: binding }),
    });
}

function compilation(style: Style) {
    return {
        newsIdentity: "A city renewal program begins in stages.",
        coreTension: "Renewal must preserve shared public space.",
        realityAnchor: "The plan concerns an existing urban neighborhood.",
        factExclusions: ["Do not invent dates, budgets, or named people."],
        sceneKernel: "One physical form passes carefully through an opening.",
        prompt: prompt(style),
    };
}

function prompt(style: Style): string {
    const styleContract =
        style === "narrative-monument"
            ? "Use a condensed charcoal figure against warm ivory mineral paper, one incomplete old-gold ring, and one exact Chinese title in cobalt-blue. No other words or pseudo-text."
            : style === "pale-watercolor"
              ? "Begin on warm old paper with pale-cyan air and gray-green transparent washes. Preserve at least one third breathing space; reject cinematic lighting and a second metaphor. No text, letters, numbers, logos or pseudo-text anywhere in the image."
              : "Use one perfectly flat field, black #141413 marks, and warm-white #FAF9F5 shapes with at least 60% empty space. NEGATIVE CONSTRAINTS must reject textures and gradients. No text, letters, numbers, logos or pseudo-text anywhere in the image.";
    return [
        "Use case: stylized-concept",
        "Asset type: horizontal editorial main visual, composed safely for a 4:3 crop",
        "NEWS RELATION: Translate only the supplied renewal event and preservation tension.",
        "ONE SCENE KERNEL: One small form moves carefully through one existing opening.",
        "COMPOSITION: Keep the action asymmetric, restrained, and physically legible.",
        `PHYSICAL MAKING RECIPE: ${styleContract}`,
        "TEXT: No text, letters, numbers, logos or pseudo-text anywhere in the image.",
        `NEGATIVE CONSTRAINTS: Reject unsupported facts, literal news diagrams, extra icons, and decorative explanations. ${styleContract}`,
    ].join("\n");
}
