import { resolve } from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
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
import type { PosterAgent, PosterAgentRequest } from "./agent.js";

export type PiPosterAgentOptions = {
    skills: readonly SkillRef[];
    cwd?: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    modelRuntime?: ModelRuntime;
};

/** Compiles one poster brief with the exact Runtime Skill and no Tools. */
export class PiPosterAgent implements PosterAgent {
    readonly #cwd: string;
    readonly #agentDir: string;
    readonly #skills: SkillSet;
    readonly #provider: string | undefined;
    readonly #model: string | undefined;
    readonly #openAIBaseUrl: string | undefined;
    readonly #openAIApiMode: OpenAIApiMode;
    readonly #models: ModelRuntime | undefined;
    #modelsPromise: Promise<ModelRuntime> | undefined;

    constructor(options: PiPosterAgentOptions) {
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

    async compile(request: PosterAgentRequest): Promise<unknown> {
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
                "You compile a business brief into a minimal-zine poster prompt.",
                "Follow the bound Runtime Skill. Do not generate an image, call a Tool, or return Markdown.",
                "Return only the strict JSON object requested by the user message.",
                loaded.instructions,
            ].join("\n\n"),
        });
        await resourceLoader.reload();

        const models = await this.#getModels();
        const selectedModel =
            this.#provider && this.#model
                ? models.getModel(this.#provider, this.#model)
                : undefined;
        if (this.#provider && !selectedModel) {
            throw new Error("The configured Pi model is unavailable");
        }

        const { session } = await createAgentSession({
            cwd: this.#cwd,
            agentDir: this.#agentDir,
            modelRuntime: models,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedModel?.api === "openai-completions"
                ? { thinkingLevel: "off" as const }
                : {}),
            resourceLoader,
            sessionManager: SessionManager.inMemory(this.#cwd),
            customTools: [],
            tools: [],
        });
        const abortSession = () => {
            void session.abort();
        };
        request.signal.addEventListener("abort", abortSession, { once: true });

        try {
            if (request.signal.aborted) {
                throw new Error("Agent request was aborted");
            }
            const textInstruction = request.text
                ? `Preserve this exact in-image text in the prompt: ${JSON.stringify(request.text)}. `
                : "Choose one short poetic in-image phrase as directed by the Skill. ";
            await session.prompt(
                `Compile this poster brief: ${JSON.stringify(request.brief)}\n` +
                    textInstruction +
                    "Return only JSON matching " +
                    '{"prompt":"exactly four paragraphs separated by blank lines","recipe":{"layout":"one allowed layout","anchor":"one allowed anchor","typography":"one allowed typography mode","accent":"one exact high-chroma hue and material form","texture":"one allowed texture mode","mood":"one allowed mood"},"interpretation":"one short sentence"}.',
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
