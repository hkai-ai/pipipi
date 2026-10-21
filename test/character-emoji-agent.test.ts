import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
    CreateAgentSessionOptions,
    CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import { PiCharacterEmojiAgent } from "../src/processes/character-emoji/agent.pi.js";
import {
    type Candidate,
    projectCandidate,
} from "../src/processes/character-emoji/candidate.js";
import { characterPersonas } from "../src/processes/character-emoji/character-personas.js";
import { fixedComicLayout } from "../src/processes/character-emoji/comic-layout.js";
import { COMIC_PLANNER_SYSTEM_PROMPT } from "../src/processes/character-emoji/comic-prompt.js";
import {
    EmojiFailure,
    emojiDiagnostic,
} from "../src/processes/character-emoji/diagnostics.js";
import {
    characterEmojiModel,
    characterEmojiProvider,
    characterEmojiSearchModel,
    createCharacterEmojiModel,
} from "../src/processes/character-emoji/model.js";
import { characterEmojiProduction } from "../src/processes/character-emoji/production.js";
import { PLANNER_SYSTEM_PROMPT } from "../src/processes/character-emoji/prompt.js";
import {
    characterEmojiBudget,
    createCharacterEmojiRegistration,
} from "../src/processes/character-emoji/registration.js";
import {
    SCENE_COMIC_RULES,
    SCENE_PLANNER_RULES,
    SCENE_SINGLE_RULES,
} from "../src/processes/character-emoji/scene-prompt.js";
import type { Brief } from "../src/processes/character-emoji/schema.js";
import type { MemeSearch } from "../src/processes/character-emoji/search.js";
import { ResponsesMemeSearch } from "../src/processes/character-emoji/search.responses.js";
import {
    characterEmojiSkillHash,
    createCharacterEmojiSkillRefs,
} from "../src/processes/character-emoji/skills.js";

const brief: Brief = {
    cast: [{ character: "DeepSeek", appearance: "Chibi" }],
    idea: "请联网搜梗，画上下文压缩后忘记任务。",
    captionSetting: { mode: "none" },
};
const plan = {
    caption: "",
    joke: "记忆整理完，任务也忘了",
    actors: [
        {
            character: "DeepSeek",
            expression: "茫然",
            action: "拿着空白笔记本",
            position: "居中",
            identityMark: null,
        },
    ],
    composition: "人物和空白笔记本占据画面",
    punchlineDetail: "记忆被打包扔进身后的箱子",
};
function internal(value: unknown): Candidate {
    const original = value as typeof plan & {
        panels?: Array<
            typeof plan & { texts: unknown[]; index: number; frame: string }
        >;
        page?: { aspectRatio: string };
    };
    const adaptation = (value as Candidate).adaptation ?? {
        entryId: null,
        original: "没有社区实例，按需求原创",
    };
    if (original.panels)
        return {
            joke: original.joke,
            continuity: (value as { continuity: string }).continuity,
            aspectRatio: original.page?.aspectRatio,
            panels: original.panels.map(
                ({ index: _index, frame: _frame, ...panel }) => panel,
            ),
            adaptation,
        } as Candidate;
    return { ...original, propMarks: [], adaptation } as Candidate;
}

const projected = projectCandidate(internal(plan));
const image = {
    url: "https://assets.example/result.png",
    contentType: "image/png" as const,
    width: 1024,
    height: 1024,
};
const assistant = (text: string, phase = "final_answer") => ({
    type: "message",
    role: "assistant",
    phase,
    status: "completed",
    content: [{ type: "output_text", text }],
});
const searched = () => ({
    status: "completed",
    output: [
        { type: "web_search_call", status: "completed" },
        assistant(
            JSON.stringify({
                entries: [],
                insufficiency: "有来源支持的具体梗",
            }),
        ),
    ],
});
const signal = () => new AbortController().signal;
const searchOptions = () => ({
    signal: signal(),
    maxKeywords: 2,
    maxOutputTokens: 4096,
});
const makeSearch = (fetcher: typeof fetch) =>
    new ResponsesMemeSearch({
        apiKey: "test-key",
        baseUrl: "https://search.example/v1",
        fetch: fetcher,
    });

function harness(
    options: {
        calls?: number;
        outputs?: unknown[];
        stopReason?: string;
        throwAfterMessage?: boolean;
        search?: MemeSearch;
        extraModelCalls?: number;
        textBlocks?: Array<{
            type: "text";
            text: string;
            textSignature?: string;
        }>;
    } = {},
) {
    let captured: CreateAgentSessionOptions | undefined;
    const outputs = options.outputs ?? [plan];
    const sessionConfigs: CreateAgentSessionOptions[] = [];
    const messages: unknown[] = [];
    const payloads: unknown[] = [];
    const prompts: string[] = [];
    const dispose = vi.fn();
    const abort = vi.fn(async () => {});
    const disableTools = vi.fn();
    const retry = vi.fn();
    const compaction = vi.fn();
    const search = options.search ?? {
        search: vi.fn(async () => ({
            status: "insufficient" as const,
            text: "找到相关素材",
            entries: [],
            sources: [{ title: "原帖", url: "https://example.org/meme" }],
        })),
    };
    const agent = new PiCharacterEmojiAgent({
        apiKey: "emoji-test-key",
        baseUrl: "https://emoji.example/v1",
        skills: createCharacterEmojiSkillRefs(),
        search,
        sessionFactory: async (config) => {
            sessionConfigs.push(config);
            captured = config;
            const tool = config.customTools?.[0];
            const state: {
                onPayload?: (body: unknown) => unknown;
            } = {};
            const request = async () => {
                payloads.push(
                    await state.onPayload?.({
                        model: characterEmojiModel,
                        max_output_tokens: 8192,
                        input: [{ role: "user", content: prompts.join("\n") }],
                        prompt_cache_key: "test-session",
                        prompt_cache_retention: "24h",
                    }),
                );
            };
            return {
                session: {
                    agent: state,
                    messages,
                    dispose,
                    abort,
                    setActiveToolsByName: disableTools,
                    setAutoRetryEnabled: retry,
                    setAutoCompactionEnabled: compaction,
                    prompt: async (text: string) => {
                        prompts.push(text);
                        await request();
                        if (prompts.length === 1) {
                            for (
                                let index = 0;
                                index < (options.calls ?? 1);
                                index++
                            ) {
                                try {
                                    if (!tool) throw new Error("没有搜索 Tool");
                                    await tool.execute(
                                        `call-${index}`,
                                        { focus: "网友关于失忆的梗" },
                                        signal(),
                                        undefined,
                                        {} as never,
                                    );
                                } catch {
                                    /* 模拟 Pi 将 Tool 错误交还模型。 */
                                }
                                await request();
                            }
                            for (
                                let i = 0;
                                i < (options.extraModelCalls ?? 0);
                                i++
                            )
                                await request();
                        }
                        const output =
                            outputs[
                                Math.min(prompts.length - 1, outputs.length - 1)
                            ];
                        messages.push({
                            role: "assistant",
                            stopReason: options.stopReason ?? "stop",
                            content: options.textBlocks ?? [
                                {
                                    type: "text",
                                    text:
                                        typeof output === "string"
                                            ? output
                                            : JSON.stringify(internal(output)),
                                },
                            ],
                        });
                        if (options.throwAfterMessage)
                            throw new Error("private upstream error");
                    },
                },
            } as unknown as CreateAgentSessionResult;
        },
    });
    return {
        agent,
        sessionConfigs,
        search,
        captured: () => {
            if (!captured) throw new Error("没有创建 Session");
            return captured;
        },
        payloads,
        prompts,
        dispose,
        abort,
        disableTools,
        retry,
        compaction,
    };
}

describe("DeepSeek 搜梗 Adapter", () => {
    it("使用固定模型与预算，提取最终正文和安全来源", async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                ...searched(),
                output: [
                    { type: "web_search_call", status: "completed" },
                    assistant("不应出现", "commentary"),
                    {
                        ...assistant("补充资料"),
                        content: [
                            {
                                type: "output_text",
                                text: JSON.stringify({
                                    entries: [],
                                    insufficiency: "补充资料",
                                }),
                                annotations: [
                                    {
                                        type: "url_citation",
                                        title: "原帖",
                                        url: "https://example.org/meme",
                                    },
                                    {
                                        type: "url_citation",
                                        title: "重复",
                                        url: "https://example.org/meme",
                                    },
                                    {
                                        type: "url_citation",
                                        url: "javascript:alert(1)",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            }),
        );
        const result = await makeSearch(fetcher).search(
            { cast: brief.cast, idea: brief.idea },
            searchOptions(),
        );
        expect(result.text).toBe("补充资料");
        expect(result.status).toBe("insufficient");
        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].url).toBe("https://example.org/meme");
        const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
        expect(body).toMatchObject({
            model: characterEmojiSearchModel,
            tools: [{ type: "web_search", max_keyword: 2 }],
            tool_choice: "required",
            reasoning: { effort: "low" },
            max_output_tokens: 4096,
        });
    });
    it("最多两个候选分别绑定原生引用，模型不负责重写来源证据", async () => {
        const entry = {
            kind: "community_secondary",
            summary: "社区转述",
            behavior: "把熟人称作用户",
            expectation: "认得熟人",
            contrast: "机械接待",
            sourceUrl: "https://example.org/meme",
        };
        const second = {
            ...entry,
            summary: "另一个社区实例",
            behavior: "忘记已经约定的昵称",
            sourceUrl: "https://example.org/another-meme",
        };
        const body = {
            status: "completed",
            output: [
                { type: "web_search_call", status: "completed" },
                {
                    ...assistant(""),
                    content: [
                        {
                            type: "output_text",
                            text: JSON.stringify({
                                entries: [entry, second],
                                insufficiency: "",
                            }),
                            annotations: [
                                {
                                    type: "url_citation",
                                    title: "原帖",
                                    url: entry.sourceUrl,
                                    summary:
                                        "实际检索摘要：网友说模型把熟人称作用户。",
                                },
                                {
                                    type: "url_citation",
                                    title: "另一原帖",
                                    url: second.sourceUrl,
                                    summary:
                                        "实际检索摘要：网友说模型忘记了约定的昵称。",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const result = await makeSearch(
            vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
        ).search({ cast: brief.cast, idea: brief.idea }, searchOptions());
        expect(result.entries).toEqual([
            expect.objectContaining({
                kind: entry.kind,
                sourceUrl: entry.sourceUrl,
                summary: expect.stringContaining(entry.behavior),
                verification: "cited",
                id: expect.any(String),
                sourceQuote: "实际检索摘要：网友说模型把熟人称作用户。",
            }),
            expect.objectContaining({
                kind: second.kind,
                sourceUrl: second.sourceUrl,
                summary: expect.stringContaining(second.behavior),
                id: expect.any(String),
                sourceQuote: "实际检索摘要：网友说模型忘记了约定的昵称。",
            }),
        ]);
        expect(result.status).toBe("usable");
        expect(result.sources[0]).not.toHaveProperty("excerpt");
    });
    it.each([false, true])(
        "搜索正文唯一完整JSON围栏可读取，其他格式保留为未核验材料：%s",
        async (duplicate) => {
            const block = [
                "```json",
                JSON.stringify({
                    entries: [],
                    insufficiency: "未发现社区实例",
                }),
                "```",
            ].join("\n");
            const raw = {
                status: "completed",
                output: [
                    { type: "web_search_call", status: "completed" },
                    assistant(`说明\n${block}${duplicate ? `\n${block}` : ""}`),
                ],
            };
            const call = makeSearch(
                vi.fn<typeof fetch>().mockResolvedValue(Response.json(raw)),
            ).search({ cast: brief.cast, idea: brief.idea }, searchOptions());
            expect((await call).entries).toHaveLength(duplicate ? 1 : 0);
        },
    );
    it("搜索完成但正文格式不合法时只作为未核验资料", async () => {
        const raw = {
            status: "completed",
            output: [
                { type: "web_search_call", status: "completed" },
                assistant('{"entries":['),
            ],
        };
        const result = await makeSearch(
            vi.fn<typeof fetch>().mockResolvedValue(Response.json(raw)),
        ).search({ cast: brief.cast, idea: brief.idea }, searchOptions());
        expect(result.entries[0]).toMatchObject({
            kind: "unverified",
            verification: "unverified",
            sourceQuote: "",
        });
        expect(result.text).toContain("不能声称是已证实的社区经历");
        expect(result.status).toBe("unverifiable");
    });
    it.each([
        ["没有搜索", { status: "completed", output: [assistant("假装搜索")] }],
        ["响应未完成", { ...searched(), status: "incomplete" }],

        ["返回错误", { ...searched(), error: { code: "error" } }],
        [
            "搜索失败",
            {
                ...searched(),
                output: [
                    ...searched().output,
                    { type: "web_search_call", status: "failed" },
                ],
            },
        ],
        [
            "拒绝",
            {
                ...searched(),
                output: [
                    ...searched().output,
                    {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "refusal" }],
                    },
                ],
            },
        ],
        [
            "空正文",
            {
                status: "completed",
                output: [
                    { type: "web_search_call", status: "completed" },
                    assistant(" "),
                ],
            },
        ],
    ])("%s 时不返回成功", async (_name, response) => {
        await expect(
            makeSearch(
                vi
                    .fn<typeof fetch>()
                    .mockResolvedValue(Response.json(response)),
            ).search({ cast: brief.cast, idea: brief.idea }, searchOptions()),
        ).rejects.toThrow();
    });
});

describe("搜梗失败诊断", () => {
    it.each([429, 503])("保留 HTTP %i，隐藏上游正文", async (status) => {
        const error = await makeSearch(
            vi
                .fn<typeof fetch>()
                .mockResolvedValue(new Response("secret upstream", { status })),
        )
            .search({ cast: brief.cast, idea: brief.idea }, searchOptions())
            .catch((error) => error);
        const diagnostic = emojiDiagnostic(error, "test-run", 100, signal());
        expect(diagnostic).toMatchObject({
            stage: "search",
            code: "http_error",
            httpStatus: status,
        });
        expect(JSON.stringify(diagnostic)).not.toMatch(
            /secret|test-key|search\.example/u,
        );
    });
    it("网络错误不会伪装成资料不足", async () => {
        await expect(
            makeSearch(
                vi
                    .fn<typeof fetch>()
                    .mockRejectedValue(new TypeError("secret upstream")),
            ).search({ cast: brief.cast, idea: brief.idea }, searchOptions()),
        ).rejects.toMatchObject({ stage: "search", code: "network" });
    });
    it("损坏的响应 JSON 保留格式错误分类", async () => {
        await expect(
            makeSearch(
                vi
                    .fn<typeof fetch>()
                    .mockResolvedValue(new Response("not json")),
            ).search({ cast: brief.cast, idea: brief.idea }, searchOptions()),
        ).rejects.toMatchObject({
            stage: "search",
            code: "invalid_response",
            httpStatus: 200,
        });
    });
    it.each([
        ["TimeoutError", "timeout"],
        ["AbortError", "cancelled"],
    ])("区分 %s 且不发送已取消请求", async (name, code) => {
        const controller = new AbortController();
        controller.abort(new DOMException("secret upstream", name));
        const fetcher = vi.fn<typeof fetch>();
        await expect(
            makeSearch(fetcher).search(
                { cast: brief.cast, idea: brief.idea },
                { ...searchOptions(), signal: controller.signal },
            ),
        ).rejects.toMatchObject({ stage: "search", code });
        expect(fetcher).not.toHaveBeenCalled();
    });
});

describe("Pi 表情包 Agent", () => {
    it("只接受最终正文，不把 Pi 合并的 commentary 拼入方案", async () => {
        const h = harness({
            textBlocks: [
                {
                    type: "text",
                    text: "以下先分析构思",
                    textSignature: JSON.stringify({
                        v: 1,
                        id: "comment",
                        phase: "commentary",
                    }),
                },
                {
                    type: "text",
                    text: JSON.stringify(internal(plan)),
                    textSignature: JSON.stringify({
                        v: 1,
                        id: "answer",
                        phase: "final_answer",
                    }),
                },
            ],
        });
        await expect(
            h.agent.plan(brief, signal(), characterEmojiBudget),
        ).resolves.toEqual(projected);
    });
    it("只有 commentary 时不得当作成功方案", async () => {
        const h = harness({
            textBlocks: [
                {
                    type: "text",
                    text: JSON.stringify(internal(plan)),
                    textSignature: JSON.stringify({
                        v: 1,
                        id: "comment",
                        phase: "commentary",
                    }),
                },
            ],
        });
        await expect(
            h.agent.plan(brief, signal(), characterEmojiBudget),
        ).rejects.toThrow();
    });
    it("加载完整固定 Skill，唯一 Tool 绑定角色和创意，使用专用模型凭证", async () => {
        const h = harness();
        expect(
            await h.agent.plan(brief, signal(), characterEmojiBudget),
        ).toEqual(projected);
        const config = h.captured();
        expect(config.tools).toEqual(["search_memes"]);
        expect(config.noTools).toBe("all");
        expect(config.model).toMatchObject({
            id: characterEmojiModel,
            provider: characterEmojiProvider,
            baseUrl: "https://emoji.example/v1",
        });
        expect(config.resourceLoader?.getSystemPrompt()).toContain(
            SCENE_SINGLE_RULES,
        );
        expect(config.resourceLoader?.getSystemPrompt()).not.toContain(
            SCENE_COMIC_RULES,
        );
        expect(h.search.search).toHaveBeenCalledWith(
            { cast: brief.cast, idea: brief.idea, focus: "网友关于失忆的梗" },
            expect.objectContaining({ maxKeywords: 2, maxOutputTokens: 4096 }),
        );
        expect(JSON.parse(h.prompts[0]).cast[0].creativeBrief).toBe(
            characterPersonas.DeepSeek,
        );
        expect(h.payloads).toHaveLength(2);
        expect(h.payloads[0]).toMatchObject({
            text: { format: { type: "json_object" } },
            reasoning: { effort: "low" },
        });
        expect(h.payloads[0]).not.toHaveProperty("prompt_cache_key");
        for (const payload of h.payloads)
            expect(payload).not.toHaveProperty("max_output_tokens");
        expect(characterEmojiModel).toBe("deepseek-v4.1-flash");
        expect(h.payloads[1]).toMatchObject({
            reasoning: { effort: "low" },
            text: { format: { type: "json_object" } },
        });
        const input = (h.payloads[1] as { input: unknown }).input as Array<{
            role: string;
            content: string;
        }>;
        const schemaMessage = input.at(-1);
        expect(schemaMessage?.role).toBe("system");
        const schema = JSON.parse(
            schemaMessage?.content.split("完整方案对象：")[1] ?? "{}",
        );
        expect(schema.required).toContain("actors");
        expect(schema.properties.adaptation.properties.entryId).toEqual({
            type: "null",
        });
        expect((h.payloads[0] as { input: unknown }).input).toHaveLength(2);
        expect(config.thinkingLevel).toBe("low");
        expect(h.payloads[0]).not.toHaveProperty("prompt_cache_retention");
        expect(
            config.settingsManager?.getProviderRetrySettings().maxRetries,
        ).toBe(0);
        expect(h.retry).toHaveBeenCalledWith(false);
        expect(h.compaction).toHaveBeenCalledWith(false);
        expect(h.dispose).toHaveBeenCalledOnce();
    });
    it("一次请求只创建一个Agent会话，自检不输出额外报告", async () => {
        const h = harness();
        const result = await h.agent.plan(
            brief,
            signal(),
            characterEmojiBudget,
        );
        expect(h.sessionConfigs).toHaveLength(1);
        expect(h.payloads).toHaveLength(2);
        expect(h.captured().resourceLoader?.getSystemPrompt()).toContain(
            "跨格结果能否由前面的动作产生",
        );
        expect(result).not.toHaveProperty("adaptation");
        expect(result).not.toHaveProperty("issues");
        expect(h.dispose).toHaveBeenCalledOnce();
    });
    it("两次构思请求即可提交，修正仍消费同一预算", async () => {
        const h = harness();
        await expect(
            h.agent.plan(brief, signal(), {
                ...characterEmojiBudget,
                maxModelCalls: 2,
            }),
        ).resolves.toEqual(projected);
        const invalid = harness({ outputs: [{ ...plan, caption: "" }] });
        await expect(
            invalid.agent.plan(
                { ...brief, captionSetting: { mode: "auto" } },
                signal(),
                { ...characterEmojiBudget, maxModelCalls: 2 },
            ),
        ).rejects.toThrow("超过预算");
        expect(invalid.sessionConfigs).toHaveLength(1);
    });
    it("Pi 写入失败消息后抛出异常时仍归类为模型失败", async () => {
        const h = harness({ stopReason: "error", throwAfterMessage: true });
        const error = await h.agent
            .plan(brief, signal(), characterEmojiBudget)
            .catch((error) => error);
        expect(error).toMatchObject({ stage: "planning", code: "model_error" });
        expect(
            JSON.stringify(emojiDiagnostic(error, "run", 100, signal())),
        ).not.toContain("private upstream");
    });
    it.each(["length", "error", "aborted"])(
        "候选响应%s时拒绝且释放唯一会话",
        async (stopReason) => {
            const h = harness({ stopReason });
            await expect(
                h.agent.plan(brief, signal(), characterEmojiBudget),
            ).rejects.toThrow();
            expect(h.sessionConfigs).toHaveLength(1);
            expect(h.dispose).toHaveBeenCalledOnce();
        },
    );
    it("不存在的来源不能提交或触发生图", async () => {
        const h = harness({
            outputs: [
                {
                    ...internal(plan),
                    adaptation: { entryId: "fake", original: "伪造来源" },
                },
            ],
        });
        const render = vi.fn(async () => image);
        const executor = createProcessExecutor({
            registrations: [
                createCharacterEmojiRegistration({
                    agent: h.agent,
                    capability: { render },
                }),
            ],
        });
        expect(
            await executor.execute({
                process: "character-emoji",
                version: "v1",
                input: brief,
            }),
        ).toMatchObject({ status: "failed" });
        expect(render).not.toHaveBeenCalled();
    });
    it.each([
        `${JSON.stringify(internal(plan))}补充说明`,
        '{"caption":"引号未转义"文字"}',
    ])("JSON 损坏或混杂正文只重交一次，仍失败则结束", async (output) => {
        const h = harness({ outputs: [output] });
        await expect(
            h.agent.plan(brief, signal(), characterEmojiBudget),
        ).rejects.toThrow();
        expect(h.prompts).toHaveLength(2);
        expect(h.search.search).toHaveBeenCalledOnce();
        expect(h.dispose).toHaveBeenCalledOnce();
    });
    it("保留原解析器的完整 JSON 围栏兼容", async () => {
        const h = harness({
            outputs: [
                ["```json", JSON.stringify(internal(plan)), "```"].join("\n"),
            ],
        });
        expect(
            await h.agent.plan(brief, signal(), characterEmojiBudget),
        ).toEqual(projected);
    });

    it("JSON 重交成功复用会话、来源和一次修正预算", async () => {
        const h = harness({ outputs: ['{"caption":', plan] });
        const observe = vi.fn();
        await expect(
            h.agent.plan(brief, signal(), characterEmojiBudget, observe),
        ).resolves.toEqual(projected);
        expect(h.payloads).toHaveLength(3);
        expect(h.prompts).toHaveLength(2);
        expect(h.sessionConfigs).toHaveLength(1);
        expect(h.search.search).toHaveBeenCalledOnce();
        expect(h.payloads[2]).not.toHaveProperty("tools");
        expect(observe).toHaveBeenLastCalledWith(
            expect.objectContaining({
                stage: "planning",
                outcome: "succeeded",
                modelCalls: 3,
                repairAttempts: 1,
                source: "original",
            }),
        );
    });

    it.each([
        [{ ...plan, action: "新增非法字段" }, "invalid_schema"],
        [{ ...plan, caption: "不该有台词" }, "business_validation"],
        [
            {
                ...internal(plan),
                adaptation: { entryId: "fake", original: "假来源" },
            },
            "invalid_source",
        ],
    ])("JSON 重交后仍有错误不得再次修正：%s", async (value, code) => {
        const h = harness({ outputs: ['{"caption":', value] });
        await expect(
            h.agent.plan(brief, signal(), characterEmojiBudget),
        ).rejects.toMatchObject({ code });
        expect(h.payloads).toHaveLength(3);
        expect(h.prompts).toHaveLength(2);
        expect(h.search.search).toHaveBeenCalledOnce();
    });

    it("成功兜底仍记录搜索503原因及runId，不记录原始异常", async () => {
        const onObservation = vi.fn();
        const h = harness({
            search: {
                search: async () => {
                    throw new EmojiFailure("search", "http_error", 12, 503);
                },
            },
        });
        const executor = createProcessExecutor({
            registrations: [
                createCharacterEmojiRegistration({
                    agent: h.agent,
                    capability: { render: async () => image },
                    onObservation,
                }),
            ],
        });
        const result = await executor.execute({
            process: "character-emoji",
            version: "v1",
            input: brief,
        });
        expect(result.status).toBe("succeeded");
        expect(onObservation).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "character_emoji_observation",
                runId: expect.any(String),
                stage: "search",
                outcome: "failed",
                code: "http_error",
                httpStatus: 503,
            }),
        );
        expect(onObservation).toHaveBeenLastCalledWith(
            expect.objectContaining({
                stage: "planning",
                source: "original",
                modelCalls: 2,
                repairAttempts: 0,
            }),
        );
        expect(JSON.stringify(onObservation.mock.calls)).not.toMatch(
            /secret|caption|idea|sourceUrl/,
        );
    });

    it("观测回调失败不增加模型请求且不影响结果", async () => {
        const h = harness();
        await expect(
            h.agent.plan(brief, signal(), characterEmojiBudget, () => {
                throw new Error("sink failed");
            }),
        ).resolves.toEqual(projected);
        expect(h.payloads).toHaveLength(2);
    });

    it("搜索独立时限先于整体截止，超时分类保留且继续原创", async () => {
        const observe = vi.fn();
        const h = harness({
            search: makeSearch(
                async (_url, init) =>
                    new Promise((_resolve, reject) => {
                        const abort = init?.signal;
                        if (!abort) throw new Error("缺少取消信号");
                        if (abort.aborted) reject(abort.reason);
                        else
                            abort.addEventListener(
                                "abort",
                                () => reject(abort.reason),
                                { once: true },
                            );
                    }),
            ),
        });
        await expect(
            h.agent.plan(
                brief,
                signal(),
                { ...characterEmojiBudget, searchTimeoutMs: 20 },
                observe,
            ),
        ).resolves.toEqual(projected);
        expect(observe).toHaveBeenCalledWith(
            expect.objectContaining({
                stage: "search",
                outcome: "failed",
                code: "timeout",
            }),
        );
        expect(h.payloads).toHaveLength(2);
        expect(characterEmojiBudget.searchTimeoutMs).toBe(30_000);
    });

    it("普通创作不注册搜索工具，首轮直接原创并记录跳过", async () => {
        const h = harness({ calls: 0 });
        const observe = vi.fn();
        await expect(
            h.agent.plan(
                { ...brief, idea: "上下文压缩后忘记任务" },
                signal(),
                characterEmojiBudget,
                observe,
            ),
        ).resolves.toEqual(projected);
        expect(h.captured().tools).toEqual([]);
        expect(h.captured().customTools).toEqual([]);
        expect(h.payloads[0]).not.toHaveProperty("tools");
        expect(h.payloads[0]).not.toHaveProperty("tool_choice");
        expect(h.search.search).not.toHaveBeenCalled();
        expect(h.payloads).toHaveLength(1);
        expect(observe).toHaveBeenCalledWith({
            stage: "search",
            outcome: "skipped",
            elapsedMs: 0,
        });
        expect(observe).toHaveBeenCalledWith(
            expect.objectContaining({
                stage: "planning",
                modelCalls: 1,
                source: "original",
            }),
        );
        expect(h.dispose).toHaveBeenCalledOnce();
    });
    it("搜索错误时关闭工具并继续原创，可交给图片能力执行", async () => {
        const h = harness({
            search: {
                search: vi.fn(async () => {
                    throw new Error("secret upstream");
                }),
            },
        });
        const render = vi.fn(async () => image);
        const executor = createProcessExecutor({
            registrations: [
                createCharacterEmojiRegistration({
                    agent: h.agent,
                    capability: { render },
                }),
            ],
        });
        expect(
            await executor.execute({
                process: "character-emoji",
                version: "v1",
                input: brief,
            }),
        ).toMatchObject({ status: "succeeded" });
        expect(render).toHaveBeenCalledOnce();
        expect(h.search.search).toHaveBeenCalledOnce();
        expect(h.disableTools).toHaveBeenCalledWith([]);
        expect(h.payloads).toHaveLength(2);
        expect(h.dispose).toHaveBeenCalledOnce();
    });
    it("允许有界补查，第三次不发搜索请求", async () => {
        const budget = { ...characterEmojiBudget, maxSearchCalls: 2 };
        const ok = harness({ calls: 2 });
        expect(await ok.agent.plan(brief, signal(), budget)).toEqual(projected);
        const h = harness({ calls: 3 });
        await expect(h.agent.plan(brief, signal(), budget)).rejects.toThrow();
        expect(h.search.search).toHaveBeenCalledTimes(2);
    });
    it("生产预算只允许一次联合检索，返回后关闭工具", async () => {
        expect(characterEmojiBudget.maxSearchCalls).toBe(1);
        const h = harness();
        await h.agent.plan(brief, signal(), characterEmojiBudget);
        expect(h.search.search).toHaveBeenCalledOnce();
        expect(h.disableTools).toHaveBeenCalledWith([]);
    });
    it("限制模型请求数，不因重复出稿扩大预算", async () => {
        const h = harness({ extraModelCalls: 3 });
        await expect(
            h.agent.plan(brief, signal(), characterEmojiBudget),
        ).rejects.toThrow("超过预算");
        expect(h.payloads).toHaveLength(3);
    });
    it("可定位字段超过上限时修正一次，仍非法则拒绝", async () => {
        const h = harness({ outputs: [{ ...plan, joke: "失忆".repeat(150) }] });
        await expect(
            h.agent.plan(brief, signal(), characterEmojiBudget),
        ).rejects.toMatchObject({ stage: "planning", code: "invalid_schema" });
        expect(h.prompts).toHaveLength(2);
    });
    it("台词修复仍非法时结束，不再次修复", async () => {
        const h = harness({
            outputs: [
                { ...plan, caption: "" },
                { ...plan, caption: "" },
            ],
        });
        await expect(
            h.agent.plan(
                { ...brief, captionSetting: { mode: "auto" } },
                signal(),
                characterEmojiBudget,
            ),
        ).rejects.toMatchObject({
            stage: "planning",
            code: "business_validation",
        });
        expect(h.prompts).toHaveLength(2);
    });
    it("同一会话接收业务错误并返回完整候选，保留历史且不再搜索", async () => {
        const h = harness({
            outputs: [
                { ...plan, caption: "" },
                { ...plan, caption: "忘光了" },
            ],
        });
        expect(
            await h.agent.plan(
                { ...brief, captionSetting: { mode: "auto" } },
                signal(),
                characterEmojiBudget,
            ),
        ).toEqual({ ...projected, caption: "忘光了" });
        expect(h.payloads[2]).toMatchObject({
            text: {
                format: {
                    type: "json_object",
                },
            },
        });
        expect(JSON.stringify(h.payloads[2])).toContain(brief.idea);
        expect(JSON.parse(h.prompts[1]).issues).toEqual([
            { path: "caption", code: "caption_setting_mismatch" },
        ]);
        expect(h.sessionConfigs).toHaveLength(1);
        expect(h.search.search).toHaveBeenCalledOnce();
        expect(h.payloads[2]).not.toHaveProperty("tools");
    });
    it("搜索子预算超时后保留剩余时间继续原创", async () => {
        let searchSignal: AbortSignal | undefined;
        const h = harness({
            search: {
                search: async (_input, options) => {
                    searchSignal = options.signal;
                    return new Promise((_resolve, reject) =>
                        options.signal.addEventListener(
                            "abort",
                            () => reject(options.signal.reason),
                            { once: true },
                        ),
                    );
                },
            },
        });
        await expect(
            h.agent.plan(brief, signal(), {
                ...characterEmojiBudget,
                timeoutMs: 500,
            }),
        ).resolves.toEqual(projected);
        expect(searchSignal).toBeDefined();
        expect(searchSignal?.aborted).toBe(true);
        expect(h.dispose).toHaveBeenCalledOnce();
    });
    it.each(["length", "error", "aborted"])(
        "拒绝 %s 结束的合法 JSON",
        async (stopReason) => {
            const h = harness({ stopReason });
            await expect(
                h.agent.plan(brief, signal(), characterEmojiBudget),
            ).rejects.toMatchObject({
                stage: "planning",
                code:
                    stopReason === "error"
                        ? "model_error"
                        : "incomplete_response",
            });
        },
    );
    it("取消会中止会话且不接受候选", async () => {
        const controller = new AbortController();
        const h = harness({
            search: {
                search: async () => {
                    controller.abort();
                    return {
                        status: "insufficient",
                        text: "检索完成",
                        sources: [],
                        entries: [],
                    };
                },
            },
        });
        await expect(
            h.agent.plan(brief, controller.signal, characterEmojiBudget),
        ).rejects.toThrow();
        expect(h.abort).toHaveBeenCalled();
        expect(h.dispose).toHaveBeenCalledOnce();
    });
    it("漫画复用同一 Agent 会话与原合同", async () => {
        const comic = {
            joke: "任务清单被遗忘",
            continuity: "同一张书桌",
            page: {
                aspectRatio: "1:1",
                layout: "上下两格",
                readingOrder: "从上到下",
            },
            panels: [1, 2].map((index) => ({
                index,
                frame: index === 1 ? "上半页" : "下半页",
                actors: plan.actors,
                composition: "人物站在书桌旁",
                texts: [],
                punchlineDetail: "书桌上的空白清单",
            })),
        };
        const h = harness({ outputs: [comic] });
        expect(
            await h.agent.planComic(
                { mode: "comic", cast: brief.cast, idea: brief.idea },
                signal(),
                characterEmojiBudget,
            ),
        ).toEqual(projectCandidate(internal(comic)));
        expect(JSON.parse(h.prompts[0]).mode).toBe("comic");
    });
    it("漫画编号由投影确定，自然台词无需修正", async () => {
        const comic = {
            joke: "打包后忘记任务",
            continuity: "同一书桌与档案袋",
            page: {
                aspectRatio: "1:1",
                layout: "上下两格",
                readingOrder: "从上到下",
            },
            panels: [1, 1].map(() => ({
                index: 1,
                frame: "半页横格",
                actors: plan.actors,
                composition: "书桌旁",
                punchlineDetail: "档案袋封好",
                texts: [
                    {
                        kind: "dialogue",
                        speaker: "DeepSeek",
                        text: "我忘了",
                        placement: "头顶",
                    },
                ],
            })),
        };
        const h = harness({ outputs: [comic] });
        const result = await h.agent.planComic(
            { mode: "comic", cast: brief.cast, idea: brief.idea },
            signal(),
            characterEmojiBudget,
        );
        expect(result.panels.map((panel) => panel.index)).toEqual([1, 2]);
        expect(result.panels.map((panel) => panel.texts[0].text)).toEqual([
            "我忘了",
            "我忘了",
        ]);
        expect(result.page).toEqual(
            fixedComicLayout({
                ...comic,
                page: { ...comic.page, aspectRatio: "1:1" as const },
                panels: comic.panels.map((panel, index) => ({
                    ...panel,
                    index: index + 1,
                })),
            }).page,
        );
        expect(h.prompts).toHaveLength(1);
        expect(h.disableTools).toHaveBeenCalledWith([]);
    });
    it.each([true, false])(
        "通过本地 /execute，已尝试搜索=%s 均可提交有效方案生图",
        async (searched) => {
            const h = harness({ calls: searched ? 1 : 0 });
            const render = vi.fn(async () => image);
            const app = createProcessingApplication({
                executor: createProcessExecutor({
                    registrations: [
                        createCharacterEmojiRegistration({
                            agent: h.agent,
                            capability: { render },
                        }),
                    ],
                }),
            });
            const { url } = await app.listen();
            try {
                const response = await fetch(`${url}/execute`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        process: "character-emoji",
                        version: "v1",
                        input: brief,
                    }),
                });
                expect((await response.json()).status).toBe("succeeded");
                expect(render).toHaveBeenCalledTimes(1);
            } finally {
                await app.close();
            }
        },
    );
});

describe("模型与 Skill 绑定", () => {
    it("专用 ModelRuntime 不依赖全局模型和 Key", async () => {
        const runtime = await createCharacterEmojiModel({
            apiKey: "private-key",
            baseUrl: "https://private.example/v1",
        });
        const auth = await runtime.getAuth(characterEmojiProvider);
        expect(JSON.stringify(auth)).toContain("private-key");
        expect(
            runtime.getModel(characterEmojiProvider, characterEmojiModel)
                ?.baseUrl,
        ).toBe("https://private.example/v1");
        expect(characterEmojiProduction.installedSkills({})).toEqual(
            createCharacterEmojiSkillRefs(),
        );
    });
    it("公共与模式Skill分别打包，摘要精确且无旧输出合同", () => {
        const refs = createCharacterEmojiSkillRefs();
        for (const ref of refs) {
            const content = readFileSync(`${ref.path}/SKILL.md`, "utf8");
            expect(content).not.toContain("\r");
            expect(createHash("sha256").update(content).digest("hex")).toBe(
                ref.sha256,
            );
            if (ref.name === "character-emoji-planner") {
                expect(ref.sha256).toBe(characterEmojiSkillHash);
                expect(content).toContain(SCENE_PLANNER_RULES);
                expect(content).not.toContain(PLANNER_SYSTEM_PROMPT);
                expect(content).not.toContain(COMIC_PLANNER_SYSTEM_PROMPT);
            } else
                expect(content).toContain(
                    ref.name.endsWith("single")
                        ? SCENE_SINGLE_RULES
                        : SCENE_COMIC_RULES,
                );
        }
    });
});

describe("v2 Pi场景合同", () => {
    const scene = {
        scene: "DeepSeek双手抱着空白笔记本，茫然看向装满记忆的箱子。",
        actors: [{ character: "DeepSeek", identityMark: null }],
        caption: "",
        propMarks: [],
    };
    const candidate = {
        ...scene,
        adaptation: { entryIds: [], original: "按用户主题原创" },
    };
    it("正常两次模型请求，唯一场景进入生图并通过v2 HTTP入口", async () => {
        const h = harness({ outputs: [JSON.stringify(candidate)] });
        const render = vi.fn(async () => image);
        const app = createProcessingApplication({
            executor: createProcessExecutor({
                registrations: [
                    createCharacterEmojiRegistration({
                        version: "v2",
                        agent: h.agent,
                        capability: { render },
                    }),
                ],
            }),
        });
        const { url } = await app.listen();
        try {
            const request = (version: string) =>
                fetch(`${url}/execute`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        process: "character-emoji",
                        version,
                        input: brief,
                    }),
                });
            const response = await request("v2");
            const body = await response.json();
            expect(body.status).toBe("succeeded");
            expect(body.version).toBe("v2");
            expect(body.output.plan).toEqual(scene);
            expect(render.mock.calls).toHaveLength(1);
            expect(
                JSON.stringify(render.mock.calls[0]).split(scene.scene),
            ).toHaveLength(2);
            expect(h.payloads).toHaveLength(2);
            expect((await (await request("v1")).json()).status).not.toBe(
                "succeeded",
            );
            expect(render.mock.calls).toHaveLength(1);
        } finally {
            await app.close();
        }
    });
    it("场景修正共用原来的第三次请求，不重新搜索", async () => {
        const h = harness({
            outputs: [
                JSON.stringify({ ...candidate, scene: "长".repeat(1601) }),
                JSON.stringify(candidate),
            ],
        });
        expect(
            await h.agent.planScene(brief, signal(), characterEmojiBudget),
        ).toEqual(scene);
        expect(h.payloads).toHaveLength(3);
        expect(h.search.search).toHaveBeenCalledTimes(1);
        expect(h.prompts[1]).toContain("scene");
    });
    it("漫画新合同在同一会话出稿，不补旧创作字段", async () => {
        const panel = {
            frame: "左侧跨两行大格",
            scene: scene.scene,
            actors: scene.actors,
            texts: [],
        };
        const h = harness({
            outputs: [
                JSON.stringify({
                    page: {
                        aspectRatio: "1:1",
                        layout: "左大右小",
                        readingOrder: "先左后右",
                    },
                    panels: [
                        panel,
                        {
                            ...panel,
                            frame: "右侧反应小格",
                            scene: "DeepSeek将箱子放在地上，单手翻开空白笔记本。",
                        },
                    ],
                    adaptation: candidate.adaptation,
                }),
            ],
        });
        const result = await h.agent.planSceneComic(
            { mode: "comic", cast: brief.cast, idea: brief.idea },
            signal(),
            characterEmojiBudget,
        );
        expect(result.panels[0].scene).toBe(scene.scene);
        expect(result.panels[0].frame).toBe("左侧跨两行大格");
        expect(result.page.layout).toBe("左大右小");
        expect(h.prompts[0]).toContain("creativeBrief");
        expect(result).not.toHaveProperty("continuity");
        expect(h.payloads).toHaveLength(2);
    });
});
