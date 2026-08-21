/** Pi provider 配置 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

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
        throw new Error("The configured OpenAI model is unavailable");
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
    if (
        !message ||
        message.stopReason === "error" ||
        message.stopReason === "aborted"
    ) {
        throw new Error("The Agent did not produce a successful response", {
            ...(message?.errorMessage
                ? { cause: new Error(message.errorMessage) }
                : {}),
        });
    }

    const text = message.content
        .filter(isTextContent)
        .map((part) => part.text)
        .join("")
        .trim();
    if (!text) throw new Error("The Agent response was empty");
    return JSON.parse(text);
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
