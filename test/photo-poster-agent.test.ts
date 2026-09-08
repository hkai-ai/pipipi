import {
    type CreateAgentSessionOptions,
    type CreateAgentSessionResult,
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { PiPhotoPosterAgent } from "../src/processes/photo-poster/agent.pi.js";
import { monoColorDesignInstructions } from "../src/processes/photo-poster/mono-color.js";
import { createPhotoPosterSkillRefs } from "../src/processes/photo-poster/skills.js";
import {
    photoPosterNames,
    photoPosterStyles,
} from "../src/processes/photo-poster/style.js";

it.each(photoPosterStyles)(
    "%s 加载固定风格全文且不开启 Tool",
    async (style) => {
        const modelRuntime = await ModelRuntime.create({
            modelsPath: null,
            refreshOnCreate: false,
        });
        let sessionOptions: CreateAgentSessionOptions | undefined;
        const prompt = vi.fn(async (_message: string) => undefined);
        const dispose = vi.fn();
        const agent = new PiPhotoPosterAgent({
            skills: createPhotoPosterSkillRefs(style),
            modelRuntime,
            sessionFactory: async (options) => {
                sessionOptions = options;
                return {
                    session: {
                        prompt,
                        dispose,
                        abort: async () => undefined,
                        messages: [
                            {
                                role: "assistant",
                                content: [
                                    {
                                        type: "text",
                                        text: '{"prompt":"compiled"}',
                                    },
                                ],
                                stopReason: "stop",
                            },
                        ],
                    },
                } as unknown as CreateAgentSessionResult;
            },
        });
        const design =
            style === "mono-color"
                ? monoColorDesignInstructions({
                      sourceImageUrl: "https://example.com/reference.png",
                      preset: "black_red_statement",
                  })
                : undefined;
        expect(
            await agent.compile({
                signal: new AbortController().signal,
                design,
            }),
        ).toEqual({ prompt: "compiled" });
        expect(sessionOptions).toMatchObject({
            noTools: "all",
            tools: [],
            customTools: [],
        });
        expect(sessionOptions?.resourceLoader?.getSystemPrompt()).toContain(
            `# ${photoPosterNames[style]}`,
        );
        expect(prompt).toHaveBeenCalledOnce();
        if (design) {
            expect(prompt.mock.calls[0]?.[0]).toContain(design);
            expect(prompt.mock.calls[0]?.[0]).toContain(
                "不再要求图片模型自行选色",
            );
            expect(prompt.mock.calls[0]?.[0]).not.toContain(
                "https://example.com",
            );
        }
        expect(dispose).toHaveBeenCalledOnce();
    },
);
