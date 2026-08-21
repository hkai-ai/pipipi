/**
 * 海报、CRT 与新闻图片共用的无 Tool Structured Agent Session。
 *
 * 这三条评测流程都只需要「把 prompt 发给模型，拿回一段 JSON」，不需要模型读写文件、
 * 执行命令或调用任何工具。本文件把这件事收敛成一个类 `PiStructuredAgent`：
 *
 * - 无 Tool：创建 Pi Session 时关掉全部工具（`noTools: "all"`，工具列表清空），
 *   模型只能输出文本，不会产生工具调用回合，因此单轮就能结束。
 * - Structured：约定模型的回答是 JSON，`run()` 返回前用 `parseAgentJson` 从消息里
 *   解析出结构化结果；各调用方再按自己的 Schema 校验 `output`。
 * - Request-local：每次 `run()` 都新建一个 in-memory Session（不落盘、不跨请求复用），
 *   结束后 `dispose()`；传入的 `AbortSignal` 会直接中止该 Session。
 * - 系统提示词由构造参数 `instructions` 与 `skills` 拼成，并关掉 Pi 默认的
 *   扩展/技能/模板/上下文文件加载，保证同一份输入总是得到同一份上下文。
 *
 * 模型选择：`provider` 与 `model` 必须成对给出，否则走 Pi 的默认模型；配置了
 * `openAIBaseUrl` 时按 `openAIApiMode` 接入自建 OpenAI 兼容网关。ModelRuntime 只在
 * 首次 `run()` 时创建一次并缓存复用。
 */
import { resolve } from "node:path";
import {
    type CreateAgentSessionOptions,
    type CreateAgentSessionResult,
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { configureOpenAI, type OpenAIApiMode, parseAgentJson } from "./pi.js";
import { createSkillSet, type SkillRef, type SkillSet } from "./skills.js";

export type PiStructuredAgentSessionFactory = (
    options: CreateAgentSessionOptions,
) => Promise<CreateAgentSessionResult>;

export type PiStructuredAgentOptions = Readonly<{
    skills: readonly SkillRef[];
    instructions: readonly string[];
    cwd?: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    modelRuntime?: ModelRuntime;
    sessionFactory?: PiStructuredAgentSessionFactory;
}>;

export type StructuredAgentRequest = Readonly<{
    prompt: string;
    signal: AbortSignal;
}>;

export type StructuredAgentResult = Readonly<{
    output: unknown;
    modelId?: string;
}>;

/** Runs one request-local, no-Tool Pi session and returns its parsed JSON. */
export class PiStructuredAgent {
    readonly #cwd: string;
    readonly #agentDir: string;
    readonly #skills: SkillSet;
    readonly #instructions: readonly string[];
    readonly #provider: string | undefined;
    readonly #model: string | undefined;
    readonly #openAIBaseUrl: string | undefined;
    readonly #openAIApiMode: OpenAIApiMode;
    readonly #models: ModelRuntime | undefined;
    readonly #sessionFactory: PiStructuredAgentSessionFactory;
    #modelsPromise: Promise<ModelRuntime> | undefined;

    constructor(options: PiStructuredAgentOptions) {
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

    async run(request: StructuredAgentRequest): Promise<StructuredAgentResult> {
        if (typeof request.prompt !== "string" || !request.prompt.trim()) {
            throw new Error("Structured Agent prompt is required");
        }

        const loaded = this.#skills.load();
        const resourceLoader = new DefaultResourceLoader({
            cwd: this.#cwd,
            agentDir: this.#agentDir,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            systemPrompt: [...this.#instructions, loaded.instructions].join(
                "\n\n",
            ),
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
            noTools: "all",
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
            await session.prompt(request.prompt);
            return Object.freeze({
                output: parseAgentJson(session.messages),
                ...(session.model?.id ? { modelId: session.model.id } : {}),
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
