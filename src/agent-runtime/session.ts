/** 为每次请求创建仅公开已绑定 Skill、配置隔离且不落盘的 Pi Session。 */

import { resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
    type AgentSession,
    type CreateAgentSessionOptions,
    type CreateAgentSessionResult,
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelGateway } from "../model-gateway.js";
import { AgentExecutionFailure } from "./failure.js";
import { configureOpenAI, type OpenAIApiMode } from "./pi.js";
import { createSkillSet, type SkillRef, type SkillSet } from "./skills.js";

import { observePiSession } from "./trace.js";

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
    gateway?: ModelGateway;
    openAIApiMode?: OpenAIApiMode;
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
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
 * in-memory Session with automatic resource discovery disabled. Callers
 * dispose the Session they receive.
 */
export class PiSessionSupport {
    readonly #cwd: string;
    readonly #agentDir: string;
    readonly #skills: SkillSet;
    readonly #instructions: readonly string[];
    readonly #provider: string | undefined;
    readonly #model: string | undefined;
    readonly #openAIBaseUrl: string | undefined;
    readonly #openAIApiKey: string | undefined;
    readonly #openAIApiMode: OpenAIApiMode;
    readonly #models: ModelRuntime | undefined;
    readonly #thinkingLevel: PiSessionOptions["thinkingLevel"];
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
        const usesOpenAI = !options.provider || options.provider === "openai";
        this.#openAIBaseUrl = usesOpenAI
            ? options.gateway?.baseUrl?.trim() || undefined
            : undefined;
        this.#openAIApiKey = usesOpenAI
            ? options.gateway?.apiKey?.trim() || undefined
            : undefined;
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
        this.#thinkingLevel = options.thinkingLevel;
        this.#sessionFactory = options.sessionFactory ?? createAgentSession;
    }

    async ready(): Promise<void> {
        this.#skills.load();
        const models = await this.#getModels();
        if (
            this.#provider &&
            (!this.#model || !models.getModel(this.#provider, this.#model))
        ) {
            throw new AgentExecutionFailure({
                stage: "session",
                code: "configuration",
            });
        }
    }

    async open(
        toolSurface: PiSessionToolSurface,
        systemPromptSuffix: readonly string[] = [],
    ): Promise<AgentSession> {
        const loaded = this.#skills.load();
        const settingsManager = SettingsManager.inMemory({
            cacheWarming: "off",
        });
        const resourceLoader = new DefaultResourceLoader({
            cwd: this.#cwd,
            agentDir: this.#agentDir,
            settingsManager,
            noExtensions: true,
            noSkills: true,
            skillsOverride: ({ diagnostics }) => ({
                skills: [...loaded.skills],
                diagnostics,
            }),
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
            throw new AgentExecutionFailure({
                stage: "session",
                code: "configuration",
            });
        }

        const { session } = await this.#sessionFactory({
            cwd: this.#cwd,
            agentDir: this.#agentDir,
            modelRuntime: models,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(this.#thinkingLevel
                ? { thinkingLevel: this.#thinkingLevel }
                : selectedModel?.api === "openai-completions"
                  ? { thinkingLevel: "off" as const }
                  : {}),
            resourceLoader,
            settingsManager,
            sessionManager: SessionManager.inMemory(this.#cwd),
            ...toolSurface,
        });
        observePiSession(session, loaded.identities, toolSurface.tools ?? []);
        return session;
    }

    #getModels(): Promise<ModelRuntime> {
        this.#modelsPromise ??= (
            this.#models
                ? Promise.resolve(this.#models)
                : ModelRuntime.create(
                      this.#openAIApiKey
                          ? {
                                credentials: new InMemoryCredentialStore(),
                                modelsPath: null,
                                refreshOnCreate: false,
                                allowModelNetwork: false,
                            }
                          : {},
                  )
        ).then(async (runtime) => {
            if (this.#openAIBaseUrl) {
                configureOpenAI(runtime, {
                    baseUrl: this.#openAIBaseUrl,
                    apiMode: this.#openAIApiMode,
                    modelId: this.#model,
                });
            }
            if (this.#openAIApiKey)
                await runtime.setRuntimeApiKey("openai", this.#openAIApiKey);
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
