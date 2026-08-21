import {
    type CreateAgentSessionOptions,
    type CreateAgentSessionResult,
    defineTool,
    type ExtensionContext,
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
    configureOpenAI,
    parseOpenAIApiMode,
} from "../src/agent-runtime/pi.js";
import {
    PiStructuredAgent,
    type PiStructuredAgentSessionFactory,
} from "../src/agent-runtime/structured.js";
import { PiTooledAgent } from "../src/agent-runtime/tooled.js";
import { PiContentAgent } from "../src/processes/content/agent.pi.js";
import {
    contentToolName,
    createContentSkillRefs,
} from "../src/processes/content/skills.js";
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

describe("tooled Pi Agent", () => {
    const echoTool = (name: string, calls: unknown[]) =>
        defineTool({
            name,
            label: name,
            description: `Echo through ${name}`,
            parameters: Type.Object({ value: Type.String() }),
            execute: async (_toolCallId, input) => {
                calls.push(input);
                return {
                    content: [{ type: "text" as const, text: input.value }],
                    details: {},
                };
            },
        });

    it("exposes exactly the listed Tools and counts the calls the model makes", async () => {
        const modelRuntime = await createEmptyModelRuntime();
        const calls: unknown[] = [];
        let captured: CreateAgentSessionOptions | undefined;
        const abort = vi.fn(async () => undefined);
        const dispose = vi.fn();
        const sessionFactory: PiStructuredAgentSessionFactory = async (
            options,
        ) => {
            captured = options;
            return fakeSessionResult({
                prompt: async () => {
                    // Stand in for the model: call the first Tool twice.
                    const tool = options.customTools?.[0];
                    if (!tool) throw new Error("no tool");
                    await tool.execute(
                        "c1",
                        { value: "one" },
                        undefined,
                        undefined,
                        fakeExtensionContext(),
                    );
                    await tool.execute(
                        "c2",
                        { value: "two" },
                        undefined,
                        undefined,
                        fakeExtensionContext(),
                    );
                },
                abort,
                dispose,
                messages: [
                    {
                        role: "assistant",
                        content: [{ type: "text", text: '{"done":true}' }],
                        stopReason: "stop",
                    },
                ],
                modelId: "test-model",
            });
        };
        const agent = new PiTooledAgent({
            skills: createPosterSkillRefs(),
            instructions: ["Plan with the Tools."],
            modelRuntime,
            sessionFactory,
        });

        const result = await agent.run({
            prompt: "Go.",
            tools: [echoTool("run_alpha", calls), echoTool("run_beta", [])],
            maxToolCalls: 3,
            signal: new AbortController().signal,
        });

        expect(result).toEqual({
            output: { done: true },
            modelId: "test-model",
            toolCalls: 2,
        });
        expect(calls).toEqual([{ value: "one" }, { value: "two" }]);
        expect(captured?.tools).toEqual(["run_alpha", "run_beta"]);
        expect(captured?.noTools).toBeUndefined();
        expect(captured?.customTools?.map((tool) => tool.name)).toEqual([
            "run_alpha",
            "run_beta",
        ]);
        expect(abort).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("aborts the session and fails once the Tool call budget is crossed", async () => {
        const modelRuntime = await createEmptyModelRuntime();
        const calls: unknown[] = [];
        const abort = vi.fn(async () => undefined);
        const dispose = vi.fn();
        let thirdCall: Promise<unknown> | undefined;
        const sessionFactory: PiStructuredAgentSessionFactory = async (
            options,
        ) =>
            fakeSessionResult({
                prompt: async () => {
                    const tool = options.customTools?.[0];
                    if (!tool) throw new Error("no tool");
                    for (const value of ["one", "two"]) {
                        await tool.execute(
                            "c",
                            { value },
                            undefined,
                            undefined,
                            fakeExtensionContext(),
                        );
                    }
                    thirdCall = tool
                        .execute(
                            "c3",
                            { value: "three" },
                            undefined,
                            undefined,
                            fakeExtensionContext(),
                        )
                        .catch((error: unknown) => error);
                    await thirdCall;
                },
                abort,
                dispose,
                messages: [
                    {
                        role: "assistant",
                        content: [{ type: "text", text: '{"done":true}' }],
                        stopReason: "stop",
                    },
                ],
            });
        const agent = new PiTooledAgent({
            skills: createPosterSkillRefs(),
            instructions: ["Plan with the Tools."],
            modelRuntime,
            sessionFactory,
        });

        await expect(
            agent.run({
                prompt: "Go.",
                tools: [echoTool("run_alpha", calls)],
                maxToolCalls: 2,
                signal: new AbortController().signal,
            }),
        ).rejects.toThrow("The Agent exceeded its Tool call budget");
        expect(calls).toEqual([{ value: "one" }, { value: "two" }]);
        await expect(thirdCall).resolves.toMatchObject({
            name: "ToolCallBudgetExceeded",
        });
        expect(abort).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("rejects an empty, duplicated or malformed Tool surface before opening a session", async () => {
        const modelRuntime = await createEmptyModelRuntime();
        const sessionFactory = vi.fn<PiStructuredAgentSessionFactory>();
        const agent = new PiTooledAgent({
            skills: createPosterSkillRefs(),
            instructions: ["Plan with the Tools."],
            modelRuntime,
            sessionFactory,
        });
        const signal = new AbortController().signal;

        await expect(
            agent.run({ prompt: "Go.", tools: [], maxToolCalls: 1, signal }),
        ).rejects.toThrow("Tooled Agent requires at least one Tool");
        await expect(
            agent.run({
                prompt: "Go.",
                tools: [echoTool("run_alpha", []), echoTool("run_alpha", [])],
                maxToolCalls: 1,
                signal,
            }),
        ).rejects.toThrow('Tool "run_alpha" is duplicated');
        await expect(
            agent.run({
                prompt: "Go.",
                tools: [echoTool("Run-Alpha", [])],
                maxToolCalls: 1,
                signal,
            }),
        ).rejects.toThrow("Tool name is invalid");
        await expect(
            agent.run({
                prompt: "Go.",
                tools: [echoTool("run_alpha", [])],
                maxToolCalls: 0,
                signal,
            }),
        ).rejects.toThrow("Tooled Agent Tool call budget must be positive");
        expect(sessionFactory).not.toHaveBeenCalled();
    });
});

describe("content Pi Agent", () => {
    it("exposes only the Business Capability Tool and returns the model's JSON", async () => {
        const modelRuntime = await createEmptyModelRuntime();
        const capabilityCalls: unknown[] = [];
        let captured: CreateAgentSessionOptions | undefined;
        const sessionFactory: PiStructuredAgentSessionFactory = async (
            options,
        ) => {
            captured = options;
            return fakeSessionResult({
                prompt: async () => {
                    const tool = options.customTools?.[0];
                    if (!tool) throw new Error("no tool");
                    await tool.execute(
                        "c1",
                        { content: "Improved copy" },
                        undefined,
                        undefined,
                        fakeExtensionContext(),
                    );
                },
                abort: vi.fn(async () => undefined),
                dispose: vi.fn(),
                messages: [
                    {
                        role: "assistant",
                        content: [
                            { type: "text", text: '{"content":"Refined"}' },
                        ],
                        stopReason: "stop",
                    },
                ],
            });
        };
        const agent = new PiContentAgent({
            skills: createContentSkillRefs(),
            modelRuntime,
            sessionFactory,
        });

        const output = await agent.optimize({
            content: "Original copy",
            signal: new AbortController().signal,
            idempotencyKey: "run-1",
            capability: {
                process: async (input, options) => {
                    capabilityCalls.push({
                        input,
                        idempotencyKey: options.idempotencyKey,
                    });
                    return { content: "Refined" };
                },
            },
        });

        expect(output).toEqual({ content: "Refined" });
        expect(capabilityCalls).toEqual([
            {
                input: { content: "Improved copy" },
                idempotencyKey: "run-1",
            },
        ]);
        expect(captured?.tools).toEqual([contentToolName]);
        expect(captured?.customTools?.map((tool) => tool.name)).toEqual([
            contentToolName,
        ]);
        expect(captured?.resourceLoader?.getSystemPrompt()).toContain(
            "You are a business content agent.",
        );
    });

    it("aborts the session when the model calls the Capability twice", async () => {
        const modelRuntime = await createEmptyModelRuntime();
        const abort = vi.fn(async () => undefined);
        let capabilityCalls = 0;
        const sessionFactory: PiStructuredAgentSessionFactory = async (
            options,
        ) =>
            fakeSessionResult({
                prompt: async () => {
                    const tool = options.customTools?.[0];
                    if (!tool) throw new Error("no tool");
                    for (const content of ["one", "two"]) {
                        await tool
                            .execute(
                                "c",
                                { content },
                                undefined,
                                undefined,
                                fakeExtensionContext(),
                            )
                            .catch(() => undefined);
                    }
                },
                abort,
                dispose: vi.fn(),
                messages: [],
            });
        const agent = new PiContentAgent({
            skills: createContentSkillRefs(),
            modelRuntime,
            sessionFactory,
        });

        await expect(
            agent.optimize({
                content: "Original copy",
                signal: new AbortController().signal,
                idempotencyKey: "run-2",
                capability: {
                    process: async () => {
                        capabilityCalls += 1;
                        return { content: "Refined" };
                    },
                },
            }),
        ).rejects.toThrow("The Agent exceeded its Tool call budget");
        expect(capabilityCalls).toBe(1);
        expect(abort).toHaveBeenCalledOnce();
    });
});

function fakeExtensionContext(): ExtensionContext {
    return {} as ExtensionContext;
}

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
