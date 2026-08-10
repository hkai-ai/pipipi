import { resolve } from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
    defineTool,
    getAgentDir,
    ModelRuntime,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    configureOpenAI,
    type OpenAIApiMode,
    parseAgentJson,
} from "../../agent-runtime/pi.js";
import {
    createSkillSet,
    type SkillRef,
    type SkillSet,
} from "../../agent-runtime/skills.js";
import type { ContentAgent, ContentAgentRequest } from "./agent.js";
import { contentToolName } from "./skills.js";

export type PiContentAgentOptions = {
    skills: readonly SkillRef[];
    cwd?: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    modelRuntime?: ModelRuntime;
};

/**
 * The production Agent adapter. Conversation state is deliberately request-local;
 * the model/auth runtime may be shared because it carries no business messages.
 */
export class PiContentAgent implements ContentAgent {
    readonly #cwd: string;
    readonly #agentDir: string;
    readonly #skills: SkillSet;
    readonly #provider: string | undefined;
    readonly #model: string | undefined;
    readonly #openAIBaseUrl: string | undefined;
    readonly #openAIApiMode: OpenAIApiMode;
    readonly #models: ModelRuntime | undefined;
    #modelsPromise: Promise<ModelRuntime> | undefined;

    constructor(options: PiContentAgentOptions) {
        if (
            (options.provider === undefined) !==
            (options.model === undefined)
        ) {
            throw new Error(
                "Pi provider and model must be configured together",
            );
        }

        this.#cwd = resolve(options.cwd ?? process.cwd());
        this.#agentDir = options.agentDir ?? getAgentDir();
        this.#skills = createSkillSet(options.skills, this.#cwd);
        this.#provider = options.provider;
        this.#model = options.model;
        this.#openAIBaseUrl = options.openAIBaseUrl?.trim() || undefined;
        this.#openAIApiMode =
            options.openAIApiMode ??
            (this.#openAIBaseUrl ? "chat-completions" : "responses");
        if (
            this.#openAIBaseUrl &&
            this.#openAIApiMode === "chat-completions" &&
            (this.#provider !== "openai" || !this.#model)
        ) {
            throw new Error(
                "OpenAI Chat Completions mode requires PI_PROVIDER=openai and PI_MODEL",
            );
        }
        this.#models = options.modelRuntime;
    }

    async optimize(request: ContentAgentRequest): Promise<unknown> {
        const loaded = this.#skills.load();
        const resourceLoader = new DefaultResourceLoader({
            cwd: this.#cwd,
            agentDir: this.#agentDir,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            systemPrompt: [
                "You are a business content agent. Follow every bound Runtime Skill and return only the requested structured result.",
                loaded.instructions,
            ].join("\n\n"),
        });
        await resourceLoader.reload();

        const businessContentTool = defineTool({
            name: contentToolName,
            label: "Process business content",
            description:
                "Run content through the service's existing Business Capability.",
            parameters: Type.Object(
                {
                    content: Type.String({ minLength: 1 }),
                },
                { additionalProperties: false },
            ),
            execute: async (_toolCallId, input, toolSignal) => {
                const signal = toolSignal
                    ? AbortSignal.any([request.signal, toolSignal])
                    : request.signal;
                const result = await request.capability.process(input, {
                    signal,
                    idempotencyKey: request.idempotencyKey,
                });
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify(result) },
                    ],
                    details: {},
                };
            },
        });

        const modelRuntime = await this.#getModels();
        const selectedModel =
            this.#provider && this.#model
                ? modelRuntime.getModel(this.#provider, this.#model)
                : undefined;
        if (this.#provider && !selectedModel) {
            throw new Error("The configured Pi model is unavailable");
        }

        // A fresh in-memory manager and session prevent messages from crossing requests.
        const { session } = await createAgentSession({
            cwd: this.#cwd,
            agentDir: this.#agentDir,
            modelRuntime,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedModel?.api === "openai-completions"
                ? { thinkingLevel: "off" as const }
                : {}),
            resourceLoader,
            sessionManager: SessionManager.inMemory(this.#cwd),
            customTools: [businessContentTool],
            tools: [contentToolName],
        });
        const abortSession = () => {
            void session.abort();
        };
        request.signal.addEventListener("abort", abortSession, { once: true });

        try {
            if (request.signal.aborted)
                throw new Error("Agent request was aborted");
            await session.prompt(
                `Optimize this content: ${JSON.stringify(request.content)}\n` +
                    `Call ${contentToolName} as directed by the Skills. ` +
                    'Return only JSON matching {"content":"non-empty string"}.',
            );
            return parseAgentJson(session.messages);
        } finally {
            request.signal.removeEventListener("abort", abortSession);
            session.dispose();
        }
    }

    #getModels(): Promise<ModelRuntime> {
        this.#modelsPromise ??= (
            this.#models ? Promise.resolve(this.#models) : ModelRuntime.create()
        ).then((runtime) => {
            if (this.#openAIBaseUrl) {
                configureOpenAI(runtime, {
                    baseUrl: this.#openAIBaseUrl,
                    apiMode: this.#openAIApiMode,
                    modelId: this.#model,
                });
            }
            return runtime;
        });
        return this.#modelsPromise;
    }
}
