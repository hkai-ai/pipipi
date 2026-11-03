/** 适配 Pi 模型配置与响应协议，保留固定错误分类并解析 JSON。 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
    AgentExecutionFailure,
    AgentJsonSyntaxError,
    agentExecutionDiagnostic,
} from "./failure.js";

export { AgentJsonSyntaxError } from "./failure.js";

export type OpenAIApiMode = "responses" | "chat-completions";

export function parseOpenAIApiMode(value: string | undefined): OpenAIApiMode {
    if (value === undefined || value === "chat-completions") {
        return "chat-completions";
    }
    if (value === "responses") return "responses";
    throw new Error("OPENAI_API_MODE must be responses or chat-completions");
}

export function configureOpenAI(
    runtime: ModelRuntime,
    options: {
        baseUrl: string;
        apiMode: OpenAIApiMode;
        modelId: string | undefined;
    },
): void {
    if (options.apiMode === "responses") {
        runtime.registerProvider("openai", { baseUrl: options.baseUrl });
        return;
    }

    const sourceModel = options.modelId
        ? runtime.getModel("openai", options.modelId)
        : undefined;
    if (!sourceModel) {
        throw new AgentExecutionFailure({
            stage: "session",
            code: "configuration",
        });
    }

    runtime.registerProvider("openai", {
        baseUrl: options.baseUrl,
        api: "openai-completions",
        models: [
            {
                id: sourceModel.id,
                name: sourceModel.name,
                api: "openai-completions",
                reasoning: sourceModel.reasoning,
                thinkingLevelMap: {
                    ...sourceModel.thinkingLevelMap,
                    off: "none",
                },
                input: [...sourceModel.input],
                cost: sourceModel.cost,
                contextWindow: sourceModel.contextWindow,
                maxTokens: sourceModel.maxTokens,
            },
        ],
    });
}

export function parseAgentJson(messages: readonly unknown[]): unknown {
    const message = messages.findLast(isAssistantMessage);
    if (!message)
        throw new AgentExecutionFailure({
            stage: "response",
            code: "empty_response",
        });
    if (message.stopReason === "aborted")
        throw new AgentExecutionFailure({
            stage: "response",
            code: "cancelled",
        });
    if (message.stopReason === "error") {
        const cause = new Error(
            message.errorMessage ??
                "The Agent did not produce a successful response",
        );
        // Pi 1.4.0 的 formatProviderError 合同；仅在 error 消息处解释明确格式。
        // 裸数字加空格可能是业务正文，不推断状态；升级 Pi 必须运行协议合同测试。
        const status = cause.message.match(
            /^(?:OpenAI API error \(([45]\d{2})\):|HTTP ([45]\d{2}):|([45]\d{2}):)(?:\s|$)/u,
        );
        if (status)
            Object.assign(cause, {
                status: Number(status[1] ?? status[2] ?? status[3]),
            });
        throw new AgentExecutionFailure(
            agentExecutionDiagnostic(cause, "request"),
            cause,
        );
    }
    if (message.stopReason === "length")
        throw new AgentExecutionFailure({
            stage: "response",
            code: "incomplete_response",
        });

    const text = message.content
        .filter(isTextContent)
        .map((part) => part.text)
        .join("")
        .trim();
    if (!text)
        throw new AgentExecutionFailure(
            { stage: "response", code: "empty_response" },
            new Error("The Agent response was empty"),
        );
    try {
        return JSON.parse(text);
    } catch {
        throw new AgentJsonSyntaxError(text);
    }
}

function isAssistantMessage(value: unknown): value is {
    role: "assistant";
    content: unknown[];
    stopReason?: string;
    errorMessage?: string;
} {
    return (
        typeof value === "object" &&
        value !== null &&
        "role" in value &&
        value.role === "assistant" &&
        "content" in value &&
        Array.isArray(value.content)
    );
}

function isTextContent(value: unknown): value is {
    type: "text";
    text: string;
} {
    return (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "text" &&
        "text" in value &&
        typeof value.text === "string"
    );
}
