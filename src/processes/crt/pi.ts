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
import type { CrtAgent, CrtAgentRequest } from "./agent.js";

export type PiCrtAgentOptions = {
    skills: readonly SkillRef[];
    cwd?: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    modelRuntime?: ModelRuntime;
};

/** Compiles one reference-image transformation prompt with no image or Tools. */
export class PiCrtAgent implements CrtAgent {
    readonly #cwd: string;
    readonly #agentDir: string;
    readonly #skills: SkillSet;
    readonly #provider: string | undefined;
    readonly #model: string | undefined;
    readonly #openAIBaseUrl: string | undefined;
    readonly #openAIApiMode: OpenAIApiMode;
    readonly #models: ModelRuntime | undefined;
    #modelsPromise: Promise<ModelRuntime> | undefined;

    constructor(options: PiCrtAgentOptions) {
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

    async compile(request: CrtAgentRequest): Promise<unknown> {
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
                "You compile one uploaded-image transformation into a TaiT CRT interface prompt.",
                "Follow the bound Runtime Skill. You cannot see the source image; direct the downstream image editor to inspect it.",
                "Do not generate an image, call a Tool, or return Markdown.",
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
            await session.prompt(
                `Compile one source-image transformation with palette ${JSON.stringify(request.palette)} and aspect ratio ${JSON.stringify(request.aspectRatio)}. ` +
                    "Return one valid JSON object on a single logical line. JSON-escape every quote and encode each paragraph separator inside prompt as \\n\\n; prompt must decode to exactly four paragraphs. " +
                    'Use the exact phrases "attached source image", "20%-30% connected open field", and "avoid" in prompt so the host can verify the visual contract. ' +
                    "Return only JSON matching " +
                    '{"prompt":"exactly four paragraphs separated by blank lines","recipe":{"wallpaperPlacement":"allowed value","crop":"allowed value","subjectCoverage":70,"windowCount":4,"windowConstellation":"allowed value","sizeHierarchy":"allowed value","dominantApplication":"allowed value","extractionCount":2,"extractionGeometry":"allowed value","cartoonTreatment":"allowed value","caricatureMutation":"allowed value","midtoneMap":"allowed value","polarity":"allowed value","signalEmphasis":"allowed value"}}.',
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
