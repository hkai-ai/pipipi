import {
    type CreateAgentSessionOptions,
    type CreateAgentSessionResult,
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
    configureOpenAI,
    parseOpenAIApiMode,
} from "../src/agent-runtime/pi.js";
import {
    PiStructuredAgent,
    type PiStructuredAgentSessionFactory,
} from "../src/agent-runtime/structured.js";
import { createPosterSkillRefs } from "../src/processes/poster/skills.js";

describe("OpenAI-compatible provider configuration", () => {
    it("routes the selected model through Chat Completions with reasoning off", async () => {
        const runtime = await ModelRuntime.create({
            modelsPath: null,
            refreshOnCreate: false,
        });

        configureOpenAI(runtime, {
            baseUrl: "https://gateway.example/v1",
            apiMode: "chat-completions",
            modelId: "gpt-5.6-terra",
        });

        const model = runtime.getModel("openai", "gpt-5.6-terra");
        expect(model).toMatchObject({
            api: "openai-completions",
            baseUrl: "https://gateway.example/v1",
            thinkingLevelMap: { off: "none" },
        });
    });

    it("rejects an unknown API mode", () => {
        expect(() => parseOpenAIApiMode("legacy-completions")).toThrow(
            "OPENAI_API_MODE must be responses or chat-completions",
        );
    });
});

describe("structured Pi Agent", () => {
    it("runs one isolated JSON session with fixed Skills and no Tools", async () => {
        const modelRuntime = await createEmptyModelRuntime();
        const prompt = vi.fn(async () => undefined);
        const abort = vi.fn(async () => undefined);
        const dispose = vi.fn();
        let captured: CreateAgentSessionOptions | undefined;
        const sessionFactory: PiStructuredAgentSessionFactory = async (
            options,
        ) => {
            captured = options;
            return fakeSessionResult({
                prompt,
                abort,
                dispose,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: '{"status":"ready"}',
                            },
                        ],
                        stopReason: "stop",
                    },
                ],
                modelId: "test-model",
            });
        };
        const agent = new PiStructuredAgent({
            skills: createPosterSkillRefs(),
            instructions: ["Compile one structured result."],
            modelRuntime,
            sessionFactory,
        });

        const result = await agent.run({
            prompt: "Return the result.",
            signal: new AbortController().signal,
        });

        expect(result).toEqual({
            output: { status: "ready" },
            modelId: "test-model",
        });
        expect(prompt).toHaveBeenCalledOnce();
        expect(prompt).toHaveBeenCalledWith("Return the result.");
        expect(abort).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();
        expect(captured).toMatchObject({
            noTools: "all",
            tools: [],
            customTools: [],
        });
        const systemPrompt = captured?.resourceLoader?.getSystemPrompt();
        expect(systemPrompt).toContain("Compile one structured result.");
        expect(systemPrompt).toContain(
            "This Runtime Skill performs prompt compilation only.",
        );
    });

    it("rejects an already aborted request and still disposes the session", async () => {
        const modelRuntime = await createEmptyModelRuntime();
        const prompt = vi.fn(async () => undefined);
        const dispose = vi.fn();
        const sessionFactory: PiStructuredAgentSessionFactory = async () =>
            fakeSessionResult({
                prompt,
                abort: vi.fn(async () => undefined),
                dispose,
                messages: [],
            });
        const agent = new PiStructuredAgent({
            skills: createPosterSkillRefs(),
            instructions: ["Compile one structured result."],
            modelRuntime,
            sessionFactory,
        });
        const controller = new AbortController();
        controller.abort();

        await expect(
            agent.run({
                prompt: "Return the result.",
                signal: controller.signal,
            }),
        ).rejects.toThrow("Agent request was aborted");
        expect(prompt).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("requires provider and model to be configured together", () => {
        expect(
            () =>
                new PiStructuredAgent({
                    skills: createPosterSkillRefs(),
                    instructions: ["Compile one structured result."],
                    provider: "openai",
                }),
        ).toThrow("Pi provider and model must be configured together");
    });
});

async function createEmptyModelRuntime(): Promise<ModelRuntime> {
    return ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
}

function fakeSessionResult(options: {
    prompt: (message: string) => Promise<void>;
    abort: () => Promise<void>;
    dispose: () => void;
    messages: unknown[];
    modelId?: string;
}): CreateAgentSessionResult {
    return {
        session: {
            prompt: options.prompt,
            abort: options.abort,
            dispose: options.dispose,
            messages: options.messages,
            ...(options.modelId ? { model: { id: options.modelId } } : {}),
        },
    } as unknown as CreateAgentSessionResult;
}
