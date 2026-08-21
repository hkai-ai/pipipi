/**
 * 海报、CRT 与新闻图片共用的无 Tool Structured Agent Session。
 *
 * 这三条流程都只需要「把 prompt 发给模型，拿回一段 JSON」，不需要模型读写文件、
 * 执行命令或调用任何工具。`PiStructuredAgent` 在共享的 `PiSessionSupport` 之上
 * 固定这件事：
 *
 * - 无 Tool：创建 Pi Session 时关掉全部工具（`noTools: "all"`，工具列表清空），
 *   模型只能输出文本，不会产生工具调用回合，因此单轮就能结束。
 * - Structured：约定模型的回答是 JSON，`run()` 返回前用 `parseAgentJson` 从消息里
 *   解析出结构化结果；各调用方再按自己的 Schema 校验 `output`。
 * - Request-local：每次 `run()` 都新建一个 in-memory Session，结束后释放；传入的
 *   `AbortSignal` 会直接中止该 Session。
 */
import { parseAgentJson } from "./pi.js";
import {
    type PiSessionFactory,
    type PiSessionOptions,
    PiSessionSupport,
    withAbortableSession,
} from "./session.js";

export type PiStructuredAgentSessionFactory = PiSessionFactory;

export type PiStructuredAgentOptions = PiSessionOptions;

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
    readonly #support: PiSessionSupport;

    constructor(options: PiStructuredAgentOptions) {
        this.#support = new PiSessionSupport(options);
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
            await session.prompt(request.prompt);
            return Object.freeze({
                output: parseAgentJson(session.messages),
                ...(session.model?.id ? { modelId: session.model.id } : {}),
            });
        });
    }
}
