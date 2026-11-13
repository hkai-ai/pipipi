/** 为文本或受控图片附件创建请求级无 Tool Session，并解析模型的 JSON 结果。 */

import { AgentExecutionFailure, agentExecutionDiagnostic } from "./failure.js";
import { parseAgentJson } from "./pi.js";
import {
    type PiSessionFactory,
    type PiSessionOptions,
    PiSessionSupport,
    withAbortableSession,
} from "./session.js";
import { promptPi } from "./trace.js";

export type PiStructuredAgentSessionFactory = PiSessionFactory;

export type PiStructuredAgentOptions = PiSessionOptions &
    Readonly<{
        jsonMode?: boolean;
        jsonSchema?: Readonly<{
            name: string;
            schema: Record<string, unknown>;
        }>;
    }>;

export type StructuredAgentRequest = Readonly<{
    prompt: string;
    signal: AbortSignal;
    images?: readonly Readonly<{
        data: string;
        mimeType: "image/png" | "image/webp";
    }>[];
}>;

export type StructuredAgentResult = Readonly<{
    output: unknown;
    modelId?: string;
}>;

/** Runs one request-local, no-Tool Pi session and returns its parsed JSON. */
export class PiStructuredAgent {
    readonly #support: PiSessionSupport;
    readonly #jsonMode: boolean;
    readonly #jsonSchema: PiStructuredAgentOptions["jsonSchema"];

    constructor(options: PiStructuredAgentOptions) {
        this.#support = new PiSessionSupport(options);
        this.#jsonMode = options.jsonMode ?? false;
        this.#jsonSchema = options.jsonSchema
            ? structuredClone(options.jsonSchema)
            : undefined;
    }

    async run(request: StructuredAgentRequest): Promise<StructuredAgentResult> {
        if (typeof request.prompt !== "string" || !request.prompt.trim()) {
            throw new Error("Structured Agent prompt is required");
        }

        const session = await this.#support
            .open({
                noTools: "all",
                customTools: [],
                tools: [],
            })
            .catch((error: unknown) => {
                throw new AgentExecutionFailure(
                    agentExecutionDiagnostic(error, "session"),
                    error,
                );
            });
        return withAbortableSession(session, request.signal, async () => {
            const api = session.model?.api;
            if (
                this.#jsonSchema &&
                api !== "openai-completions" &&
                api !== "openai-responses"
            )
                throw new AgentExecutionFailure({
                    stage: "session",
                    code: "configuration",
                });
            if (
                this.#jsonSchema ||
                (this.#jsonMode && api === "openai-completions")
            ) {
                const previous = session.agent.onPayload;
                session.agent.onPayload = async (payload, model) => {
                    const next = (await previous?.(payload, model)) ?? payload;
                    if (
                        !next ||
                        typeof next !== "object" ||
                        Array.isArray(next)
                    )
                        throw new Error("JSON 请求载荷必须为对象");
                    if (this.#jsonSchema && api === "openai-responses")
                        return {
                            ...next,
                            text: {
                                ...("text" in next &&
                                next.text &&
                                typeof next.text === "object"
                                    ? next.text
                                    : {}),
                                format: {
                                    type: "json_schema",
                                    ...this.#jsonSchema,
                                    strict: true,
                                },
                            },
                        };
                    return {
                        ...next,
                        response_format: this.#jsonSchema
                            ? {
                                  type: "json_schema",
                                  json_schema: {
                                      ...this.#jsonSchema,
                                      strict: true,
                                  },
                              }
                            : { type: "json_object" },
                    };
                };
            }
            const images = request.images?.map((image) => ({
                type: "image" as const,
                ...image,
            }));
            if (images?.length && !session.model?.input.includes("image")) {
                throw new AgentExecutionFailure({
                    stage: "session",
                    code: "configuration",
                });
            }
            await promptPi(session, request.prompt, {
                expandPromptTemplates: false,
                ...(images?.length ? { images } : {}),
            }).catch((error: unknown) => {
                throw new AgentExecutionFailure(
                    agentExecutionDiagnostic(error, "request"),
                    error,
                );
            });
            request.signal.throwIfAborted();
            return Object.freeze({
                output: parseAgentJson(session.messages),
                ...(session.model?.id ? { modelId: session.model.id } : {}),
            });
        });
    }
}
