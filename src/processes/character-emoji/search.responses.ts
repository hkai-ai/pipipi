/** 调用固定 DeepSeek Responses 联网搜梗，校验完成状态并保留来源。 */
import { z } from "zod";
import { cancellationCode, EmojiFailure } from "./diagnostics.js";
import {
    type CharacterEmojiModelConfig,
    characterEmojiSearchModel,
} from "./model.js";
import { readPlannerJson } from "./planner-output.js";
import {
    bindResearch,
    type MemeResearch,
    type MemeSearch,
    researchSchema,
} from "./search.js";
import { MEME_SEARCH_PROMPT } from "./search-prompt.js";

const responseSchema = z.object({
    status: z.string(),
    error: z.unknown().optional(),
    incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
    output: z.array(
        z.object({
            type: z.string(),
            role: z.string().optional(),
            phase: z.string().nullish(),
            status: z.string().optional(),
            content: z
                .array(
                    z.object({
                        type: z.string(),
                        text: z.string().optional(),
                        annotations: z
                            .array(
                                z.object({
                                    type: z.string(),
                                    title: z.string().optional(),
                                    url: z.string().optional(),
                                    summary: z.string().optional(),
                                }),
                            )
                            .optional(),
                    }),
                )
                .optional(),
        }),
    ),
});

export class ResponsesMemeSearch implements MemeSearch {
    readonly #config: CharacterEmojiModelConfig;
    readonly #fetch: typeof fetch;
    constructor(config: CharacterEmojiModelConfig & { fetch?: typeof fetch }) {
        this.#config = config;
        this.#fetch = config.fetch ?? globalThis.fetch;
    }
    async search(
        input: Parameters<MemeSearch["search"]>[0],
        options: Parameters<MemeSearch["search"]>[1],
    ): Promise<MemeResearch> {
        const started = Date.now();
        let httpStatus: number | undefined;
        try {
            options.signal.throwIfAborted();
            if (!this.#config.apiKey.trim())
                throw new EmojiFailure("search", "configuration");
            let endpoint: URL;
            try {
                endpoint = new URL(
                    "responses",
                    `${this.#config.baseUrl.replace(/\/+$/u, "")}/`,
                );
            } catch {
                throw new EmojiFailure("search", "configuration");
            }
            const response = await this.#fetch(endpoint, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.#config.apiKey.trim()}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: characterEmojiSearchModel,
                    input: [
                        { role: "system", content: MEME_SEARCH_PROMPT },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "input_text",
                                    text: JSON.stringify(input),
                                },
                            ],
                        },
                    ],
                    stream: false,
                    tools: [
                        {
                            type: "web_search",
                            max_keyword: options.maxKeywords,
                        },
                    ],
                    tool_choice: "required",
                    reasoning: { effort: "low" },
                    text: {
                        format: {
                            type: "json_schema",
                            name: "meme_research",
                            strict: true,
                            schema: z.toJSONSchema(researchSchema),
                        },
                    },
                    max_output_tokens: options.maxOutputTokens,
                }),
                signal: options.signal,
            });
            httpStatus = response.status;
            if (!response.ok) throw new EmojiFailure("search", "http_error");
            return extractResearch(await response.json());
        } catch (error) {
            const code = options.signal.aborted
                ? cancellationCode(options.signal)
                : error instanceof EmojiFailure
                  ? error.code
                  : error instanceof SyntaxError
                    ? "invalid_response"
                    : "network";
            throw new EmojiFailure(
                "search",
                code,
                Date.now() - started,
                httpStatus,
            );
        }
    }
}
function extractResearch(raw: unknown): MemeResearch {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new EmojiFailure("search", "invalid_response");
    const body = parsed.data;
    const assistant = body.output.filter(
        (item) => item.type === "message" && item.role === "assistant",
    );
    const final = assistant.filter((item) => item.phase === "final_answer");
    const messages = final.length
        ? final
        : assistant.filter((item) => item.phase !== "commentary");
    const searches = body.output.filter(
        (item) => item.type === "web_search_call",
    );
    if (
        body.incomplete_details?.reason === "content_filter" ||
        assistant.some((item) =>
            item.content?.some((part) => part.type === "refusal"),
        )
    )
        throw new EmojiFailure("search", "refused");
    if (
        body.status !== "completed" ||
        body.error ||
        messages.some((item) => item.status && item.status !== "completed")
    )
        throw new EmojiFailure("search", "incomplete_response");
    if (
        searches.some((item) => item.status !== "completed") ||
        searches.length === 0
    )
        throw new EmojiFailure("search", "incomplete_search");
    const text = messages
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("\n");
    if (!text.trim()) throw new EmojiFailure("search", "empty_response");
    const sources = messages
        .flatMap((item) => item.content ?? [])
        .flatMap((part) => part.annotations ?? [])
        .filter((item) => item.type === "url_citation")
        .flatMap((item) => {
            if (!item.url || item.url.length > 2048) return [];
            try {
                const url = new URL(item.url);
                if (
                    !["https:", "http:"].includes(url.protocol) ||
                    url.username ||
                    url.password
                )
                    return [];
                return [
                    {
                        title: (item.title ?? "").slice(0, 300),
                        url: url.href,
                        excerpt: item.summary?.slice(0, 16000),
                    },
                ];
            } catch {
                return [];
            }
        });
    const citations = [
        ...new Map(sources.map((item) => [item.url, item])).values(),
    ].slice(0, 10);
    try {
        return bindResearch(searchJson(text), citations);
    } catch {
        // 完成的搜索正文不因 JSON 格式丢弃；仅作未核验资料，不能冒充原生引用。
        return bindResearch(
            {
                entries: [
                    {
                        kind: "unverified",
                        summary: text.slice(0, 4000),
                        sourceUrl: "",
                    },
                ],
            },
            citations,
        );
    }
}

// 当前搜索路由偶尔在严格JSON前附说明；只允许唯一完整围栏，仍执行全部来源合同。
function searchJson(text: string): unknown {
    try {
        return readPlannerJson(text);
    } catch {
        const blocks = [
            ...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/gi),
        ];
        if (blocks.length !== 1 || text.split("```").length !== 3)
            throw new Error("表情包搜索结构无法读取");
        return JSON.parse(blocks[0][1]);
    }
}
