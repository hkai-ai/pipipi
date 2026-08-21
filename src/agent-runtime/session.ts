/**
 * 请求级 Pi Session 的共享支撑：校验模型选项、固定 Skill 集合、编译系统提示、
 * 缓存 ModelRuntime，并为每次请求创建一个不落盘的内存 Session。
 *
 * 无 Tool 的 Structured Agent 与带 Tool 的 Tooled Agent 都建立在它之上；两者只决定
 * 各自的 Tool 表面和对结果的解释，不重复这些创建细节。
 */
import { resolve } from "node:path";
import {
    type AgentSession,
    type CreateAgentSessionOptions,
    type CreateAgentSessionResult,
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { configureOpenAI, type OpenAIApiMode } from "./pi.js";
import { createSkillSet, type SkillRef, type SkillSet } from "./skills.js";

export type PiSessionFactory = (
    options: CreateAgentSessionOptions,
) => Promise<CreateAgentSessionResult>;

export type PiSessionOptions = Readonly<{
    skills: readonly SkillRef[];
    instructions: readonly string[];
    cwd?: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    modelRuntime?: ModelRuntime;
    sessionFactory?: PiSessionFactory;
}>;

/** The Tool surface one request exposes; everything else stays disabled. */
export type PiSessionToolSurface = Pick<
    CreateAgentSessionOptions,
    "noTools" | "tools" | "customTools"
>;

/**
 * Owns the fixed parts of a request-local Pi Session. `open` builds a fresh
 * in-memory Session with Pi's extensions, Skills, prompt templates, themes and
 * context files all switched off, so the same inputs always see the same
 * context; callers dispose the Session they receive.
 */
export class PiSessionSupport {
    readonly #cwd: string;
    readonly #agentDir: string;
    readonly #skills: SkillSet;
    readonly #instructions: readonly string[];
    readonly #provider: string | undefined;
    readonly #model: string | undefined;
    readonly #openAIBaseUrl: string | undefined;
    readonly #openAIApiMode: OpenAIApiMode;
    readonly #models: ModelRuntime | undefined;
    readonly #sessionFactory: PiSessionFactory;
    #modelsPromise: Promise<ModelRuntime> | undefined;

    constructor(options: PiSessionOptions) {
        if (
            (options.provider === undefined) !==
            (options.model === undefined)
        ) {
            throw new Error(
                "Pi provider and model must be configured together",
            );
        }
        if (
            !Array.isArray(options.instructions) ||
            options.instructions.length === 0 ||
            options.instructions.some(
                (instruction) =>
                    typeof instruction !== "string" ||
                    instruction.trim().length === 0,
            )
        ) {
            throw new Error("Structured Agent instructions are required");
        }

        this.#cwd = resolve(options.cwd ?? process.cwd());
        this.#agentDir = options.agentDir ?? getAgentDir();
        this.#skills = createSkillSet(options.skills, this.#cwd);
        this.#instructions = Object.freeze(
            options.instructions.map((instruction) => instruction.trim()),
        );
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
        this.#sessionFactory = options.sessionFactory ?? createAgentSession;
    }

    async open(
        toolSurface: PiSessionToolSurface,
        systemPromptSuffix: readonly string[] = [],
    ): Promise<AgentSession> {
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
                ...this.#instructions,
                loaded.instructions,
                ...systemPromptSuffix,
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

        const { session } = await this.#sessionFactory({
            cwd: this.#cwd,
            agentDir: this.#agentDir,
            modelRuntime: models,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedModel?.api === "openai-completions"
                ? { thinkingLevel: "off" as const }
                : {}),
            resourceLoader,
            sessionManager: SessionManager.inMemory(this.#cwd),
            ...toolSurface,
        });
        return session;
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

/**
 * Runs `operation` against a Session that the request's signal can abort, and
 * disposes the Session whatever happens. An already-aborted request never
 * prompts the model.
 */
export async function withAbortableSession<Result>(
    session: AgentSession,
    signal: AbortSignal,
    operation: () => Promise<Result>,
): Promise<Result> {
    const abortSession = () => {
        void session.abort();
    };
    signal.addEventListener("abort", abortSession, { once: true });
    try {
        if (signal.aborted) throw new Error("Agent request was aborted");
        return await operation();
    } finally {
        signal.removeEventListener("abort", abortSession);
        session.dispose();
    }
}
