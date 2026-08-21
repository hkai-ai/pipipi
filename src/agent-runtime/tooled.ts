/**
 * 带 Tool 的 Structured Agent Session：每次请求只挂载调用方显式传入的 Tool，
 * 对调用次数设硬上限，最终仍只接受一段 JSON 文本作为结果。
 *
 * 与 `PiStructuredAgent` 的差别只有 Tool 表面。Pi 的内置 Tool（read、bash、edit、
 * write）始终不启用；Tool 能做什么由调用方在 `execute` 里决定，本文件只保证
 * 名称唯一、只有列出的 Tool 可见，以及超过预算后 Session 被中止。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseAgentJson } from "./pi.js";
import {
    type PiSessionOptions,
    PiSessionSupport,
    withAbortableSession,
} from "./session.js";

const toolNamePattern = /^[a-z][a-z0-9_]{0,63}$/;

export type PiTooledAgentOptions = PiSessionOptions;

export type TooledAgentRequest = Readonly<{
    prompt: string;
    /** The complete Tool surface for this request; nothing else is enabled. */
    tools: readonly ToolDefinition[];
    /** Hard ceiling on Tool calls; the Session is aborted once it is crossed. */
    maxToolCalls: number;
    signal: AbortSignal;
}>;

export type TooledAgentResult = Readonly<{
    output: unknown;
    modelId?: string;
    /** Tool calls the model actually made, including any that threw. */
    toolCalls: number;
}>;

export class ToolCallBudgetExceeded extends Error {
    constructor() {
        super("The Agent exceeded its Tool call budget");
        this.name = "ToolCallBudgetExceeded";
    }
}

/** Runs one request-local Pi session with an explicit Tool allow-list. */
export class PiTooledAgent {
    readonly #support: PiSessionSupport;

    constructor(options: PiTooledAgentOptions) {
        this.#support = new PiSessionSupport(options);
    }

    async run(request: TooledAgentRequest): Promise<TooledAgentResult> {
        if (typeof request.prompt !== "string" || !request.prompt.trim()) {
            throw new Error("Tooled Agent prompt is required");
        }
        if (
            !Number.isSafeInteger(request.maxToolCalls) ||
            request.maxToolCalls < 1
        ) {
            throw new Error("Tooled Agent Tool call budget must be positive");
        }
        const names = toolNames(request.tools);

        let toolCalls = 0;
        let budgetExceeded = false;
        // `abortSession` is bound after the Session exists; a Tool can only run
        // once the model has been prompted, which is after that point.
        let abortSession: () => void = () => {};
        const guardedTools = request.tools.map((tool) => ({
            ...tool,
            execute: async (
                ...parameters: Parameters<ToolDefinition["execute"]>
            ) => {
                toolCalls += 1;
                if (toolCalls > request.maxToolCalls) {
                    budgetExceeded = true;
                    abortSession();
                    throw new ToolCallBudgetExceeded();
                }
                return tool.execute(...parameters);
            },
        }));

        const session = await this.#support.open({
            customTools: guardedTools,
            tools: [...names],
        });
        abortSession = () => {
            void session.abort();
        };
        return withAbortableSession(session, request.signal, async () => {
            await session.prompt(request.prompt);
            if (budgetExceeded) throw new ToolCallBudgetExceeded();
            return Object.freeze({
                output: parseAgentJson(session.messages),
                ...(session.model?.id ? { modelId: session.model.id } : {}),
                toolCalls,
            });
        });
    }
}

function toolNames(tools: readonly ToolDefinition[]): readonly string[] {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error("Tooled Agent requires at least one Tool");
    }
    const names = new Set<string>();
    for (const tool of tools) {
        if (
            typeof tool?.name !== "string" ||
            !toolNamePattern.test(tool.name)
        ) {
            throw new Error("Tool name is invalid");
        }
        if (names.has(tool.name)) {
            throw new Error(`Tool "${tool.name}" is duplicated`);
        }
        if (typeof tool.execute !== "function") {
            throw new Error(`Tool "${tool.name}" has no execute function`);
        }
        names.add(tool.name);
    }
    return Object.freeze([...names]);
}
