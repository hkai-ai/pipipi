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

import { observePiSession, tracePiAbort } from "./trace.js";

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
    /**
     * 把 Skill 正文放在系统提示最前，易变的任务指令随后。供应商按请求前缀
     * 自动缓存，Skill 很大且各次调用的指令不同时，默认顺序会让前缀从第一行
     * 起就不同而无法命中。缺省保持「指令、Skill」的历史顺序。
     */
    skillFirst?: boolean;
    /**
     * 固定 OpenAI `prompt_cache_key`（至多 64 字符），让同一 Skill 的调用被路由到同一缓存。
     * Pi 默认用每个会话的随机 ID，等于每次换键；缺省不改载荷。
     */
    promptCacheKey?: string;
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
    readonly #skillFirst: boolean;
    readonly #promptCacheKey: string | undefined;
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
        this.#skillFirst = options.skillFirst ?? false;
        if (
            options.promptCacheKey !== undefined &&
            !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/u.test(options.promptCacheKey)
        )
            throw new Error("Pi prompt cache key is invalid");
        this.#promptCacheKey = options.promptCacheKey;
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
            systemPrompt: (this.#skillFirst
                ? [loaded.instructions, ...this.#instructions]
                : [...this.#instructions, loaded.instructions]
            )
                .concat(systemPromptSuffix)
                .join("\n\n"),
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
        const cacheKey = this.#promptCacheKey;
        if (cacheKey) {
            const previous = session.agent.onPayload;
            session.agent.onPayload = async (payload, model) => {
                const next = (await previous?.(payload, model)) ?? payload;
                return next && typeof next === "object" && !Array.isArray(next)
                    ? { ...next, prompt_cache_key: cacheKey }
                    : next;
            };
        }
        observePiSession(session, loaded.versions, toolSurface.tools ?? []);
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
        tracePiAbort(session, signal);
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
