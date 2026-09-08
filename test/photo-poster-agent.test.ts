import {
    type CreateAgentSessionOptions,
    type CreateAgentSessionResult,
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { PiPhotoPosterAgent } from "../src/processes/photo-poster/agent.pi.js";
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
        expect(
            await agent.compile({ signal: new AbortController().signal }),
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
        expect(dispose).toHaveBeenCalledOnce();
    },
);
