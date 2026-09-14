/** 为文本或受控图片附件创建请求级无 Tool Session，并解析模型的 JSON 结果。 */
import { parseAgentJson } from "./pi.js";
import {
    type PiSessionFactory,
    type PiSessionOptions,
    PiSessionSupport,
    withAbortableSession,
} from "./session.js";

export type PiStructuredAgentSessionFactory = PiSessionFactory;

export type PiStructuredAgentOptions = PiSessionOptions &
    Readonly<{ jsonMode?: boolean }>;

export type StructuredAgentRequest = Readonly<{
    prompt: string;
    signal: AbortSignal;
    images?: readonly Readonly<{ data: string; mimeType: "image/png" }>[];
}>;

export type StructuredAgentResult = Readonly<{
    output: unknown;
    modelId?: string;
}>;

/** Runs one request-local, no-Tool Pi session and returns its parsed JSON. */
export class PiStructuredAgent {
    readonly #support: PiSessionSupport;
    readonly #jsonMode: boolean;

    constructor(options: PiStructuredAgentOptions) {
        this.#support = new PiSessionSupport(options);
        this.#jsonMode = options.jsonMode ?? false;
    }

    async run(request: StructuredAgentRequest): Promise<StructuredAgentResult> {
        if (typeof request.prompt !== "string" || !request.prompt.trim()) {
            throw new Error("Structured Agent prompt is required");
        }

        const session = await this.#support.open({
            noTools: "all",
            customTools: [],
            tools: [],
        });
        return withAbortableSession(session, request.signal, async () => {
            if (this.#jsonMode && session.model?.api === "openai-completions") {
                const previous = session.agent.onPayload;
                session.agent.onPayload = async (payload, model) => {
                    const next = (await previous?.(payload, model)) ?? payload;
                    if (
                        !next ||
                        typeof next !== "object" ||
                        Array.isArray(next)
                    )
                        throw new Error("JSON 请求载荷必须为对象");
                    return {
                        ...next,
                        response_format: { type: "json_object" },
                    };
                };
            }
            if (request.images?.length) {
                if (!session.model?.input.includes("image")) {
                    throw new Error("当前模型不支持图片输入");
                }
                await session.prompt(request.prompt, {
                    images: request.images.map((image) => ({
                        type: "image",
                        ...image,
                    })),
                    expandPromptTemplates: false,
                });
            } else {
                await session.prompt(request.prompt);
            }
            return Object.freeze({
                output: parseAgentJson(session.messages),
                ...(session.model?.id ? { modelId: session.model.id } : {}),
            });
        });
    }
}
