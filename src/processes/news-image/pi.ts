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
import type {
    NewsImageAgent,
    NewsImageAgentRequest,
    NewsImageCompilation,
} from "./agent.js";

export type PiNewsImageAgentOptions = {
    skills: readonly SkillRef[];
    style: "narrative-monument" | "pale-watercolor" | "raw-humanism";
    cwd?: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    modelRuntime?: ModelRuntime;
};

/** Compiles one factual news brief with one fixed semantic style and no Tools. */
export class PiNewsImageAgent implements NewsImageAgent {
    readonly #cwd: string;
    readonly #agentDir: string;
    readonly #skills: SkillSet;
    readonly #provider: string | undefined;
    readonly #model: string | undefined;
    readonly #openAIBaseUrl: string | undefined;
    readonly #openAIApiMode: OpenAIApiMode;
    readonly #models: ModelRuntime | undefined;
    readonly #style: "narrative-monument" | "pale-watercolor" | "raw-humanism";
    #modelsPromise: Promise<ModelRuntime> | undefined;

    constructor(options: PiNewsImageAgentOptions) {
        if (
            (options.provider === undefined) !==
            (options.model === undefined)
        ) {
            throw new Error(
                "Pi provider and model must be configured together",
            );
        }
        this.#cwd = resolve(options.cwd ?? process.cwd());
        this.#style = options.style;
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

    async compile(
        request: NewsImageAgentRequest,
    ): Promise<NewsImageCompilation> {
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
                `You compile factual news into one style-${this.#style} image prompt.`,
                "Follow the bound Runtime Skill. Do not generate an image, call a Tool, read a URL, or return Markdown.",
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
        const abortSession = () => void session.abort();
        request.signal.addEventListener("abort", abortSession, { once: true });

        try {
            if (request.signal.aborted) {
                throw new Error("Agent request was aborted");
            }
            await session.prompt(
                `Compile this news title: ${JSON.stringify(request.title)}\n` +
                    `News summary: ${JSON.stringify(request.summary)}\n` +
                    "Return only JSON matching " +
                    '{"newsIdentity":"one sentence","coreTension":"one sentence","realityAnchor":"one sentence","factExclusions":["one to five unsupported facts to avoid"],"sceneKernel":"one to three sentences","prompt":"the complete English prompt"}.',
            );
            const promptModel = session.model?.id;
            if (!promptModel) {
                throw new Error("The Pi model used for compilation is unknown");
            }
            return Object.freeze({
                output: parseAgentJson(session.messages),
                promptModel,
            });
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
