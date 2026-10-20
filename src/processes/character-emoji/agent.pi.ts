/** 在受限 Pi 会话中选用本地素材、按需搜梗并提交经业务校验的方案。 */

import {
    createAgentSession,
    defineTool,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import {
    AgentJsonSyntaxError,
    parseAgentJson,
} from "../../agent-runtime/pi.js";
import {
    type PiSessionFactory,
    PiSessionSupport,
    withAbortableSession,
} from "../../agent-runtime/session.js";
import type { SkillRef } from "../../agent-runtime/skills.js";
import type {
    CharacterEmojiAgent,
    CharacterEmojiBudget,
    SceneEmojiAgent,
} from "./agent.js";
import type { AiTextOutputFailure } from "./agent-types.js";
import {
    acceptCandidate,
    candidateSchema,
    projectCandidate,
} from "./candidate.js";
import { parseComicPlannerOutput } from "./comic-output.js";
import { comicPlannerInput } from "./comic-prompt.js";
import {
    createCorrection,
    createSchemaCorrection,
    JSON_CORRECTION_PROMPT,
} from "./correction.js";
import {
    cancellationCode,
    EmojiFailure,
    type EmojiObservation,
    planningIssues,
} from "./diagnostics.js";
import {
    type AdaptationSource,
    adaptationSource,
    memesForAgent,
    selectMemes,
} from "./materials.js";
import { memeLibraryVersion } from "./memes.js";
import {
    type CharacterEmojiModelConfig,
    characterEmojiModel,
    characterEmojiProvider,
    createCharacterEmojiModel,
} from "./model.js";
import { parsePlannerOutput, readPlannerJson } from "./planner-output.js";
import { plannerInput } from "./prompt.js";
import {
    acceptSceneCandidate,
    parseSceneComicPlan,
    parseScenePlan,
    projectSceneCandidate,
    sceneCandidateSchema,
} from "./scene.js";
import type { Brief, ComicBrief } from "./schema.js";
import {
    type MemeResearch,
    type MemeSearch,
    originalResearch,
    researchForAgent,
} from "./search.js";
import { allowsMemeSearch } from "./search-policy.js";

export type PiCharacterEmojiAgentOptions = CharacterEmojiModelConfig & {
    skills: readonly SkillRef[];
    search: MemeSearch;
    sessionFactory?: PiSessionFactory;
};

export class PiCharacterEmojiAgent
    implements CharacterEmojiAgent, SceneEmojiAgent
{
    readonly #options: PiCharacterEmojiAgentOptions;
    #supports = new Map<string, Promise<PiSessionSupport>>();
    #model: ReturnType<typeof createCharacterEmojiModel> | undefined;

    constructor(options: PiCharacterEmojiAgentOptions) {
        this.#options = options;
    }

    planScene(
        brief: Brief,
        signal: AbortSignal,
        budget: CharacterEmojiBudget,
        observe?: (record: EmojiObservation) => void,
    ) {
        return this.#plan(
            "single",
            brief,
            plannerInput(brief),
            signal,
            budget,
            (text) => parseScenePlan(text, brief),
            observe,
            "scene",
        );
    }

    planSceneComic(
        brief: ComicBrief,
        signal: AbortSignal,
        budget: CharacterEmojiBudget,
        observe?: (record: EmojiObservation) => void,
    ) {
        return this.#plan(
            "comic",
            brief,
            comicPlannerInput(brief),
            signal,
            budget,
            (text) => parseSceneComicPlan(text, brief),
            observe,
            "scene",
        );
    }

    plan(
        brief: Brief,
        signal: AbortSignal,
        budget: CharacterEmojiBudget,
        observe?: (record: EmojiObservation) => void,
    ) {
        return this.#plan(
            "single",
            brief,
            plannerInput(brief),
            signal,
            budget,
            (text) => parsePlannerOutput(text, brief),
            observe,
        );
    }

    planComic(
        brief: ComicBrief,
        signal: AbortSignal,
        budget: CharacterEmojiBudget,
        observe?: (record: EmojiObservation) => void,
    ) {
        return this.#plan(
            "comic",
            brief,
            comicPlannerInput(brief),
            signal,
            budget,
            (text) => parseComicPlannerOutput(text, brief),
            observe,
        );
    }

    async #plan<T>(
        mode: "single" | "comic",
        brief: Brief | ComicBrief,
        input: string,
        callerSignal: AbortSignal,
        budget: CharacterEmojiBudget,
        parse: (
            text: string,
        ) =>
            | { success: true; plan: T }
            | ({ success: false } & AiTextOutputFailure),
        observe?: (record: EmojiObservation) => void,
        format: "legacy" | "scene" = "legacy",
    ): Promise<T> {
        const started = Date.now();
        const deadline = started + budget.timeoutMs;
        const signal = AbortSignal.any([
            callerSignal,
            AbortSignal.timeout(budget.timeoutMs),
        ]);
        signal.throwIfAborted();
        const report = (record: EmojiObservation) => {
            try {
                observe?.(record);
            } catch {
                // 观测失败不改变业务结果或调用预算。
            }
        };
        const local = format === "scene" ? selectMemes(brief) : [];
        const searchAllowed =
            budget.maxSearchCalls > 0 && allowsMemeSearch(brief.idea);
        const research: MemeResearch[] = [];
        const schema = () =>
            format === "scene"
                ? sceneCandidateSchema(mode, research, local)
                : candidateSchema(mode, research);
        const accept = (raw: unknown) => {
            if (format === "scene") {
                const candidate = acceptSceneCandidate(
                    raw,
                    mode,
                    research,
                    local,
                );
                return { candidate, plan: projectSceneCandidate(candidate) };
            }
            const candidate = acceptCandidate(raw, mode, research);
            return { candidate, plan: projectCandidate(candidate) };
        };
        let calls = 0;
        let completedSearches = 0;
        let failed = false;
        let repairing = false;
        const tool = defineTool({
            name: "search_memes",
            label: "搜索角色梗",
            description:
                "仅在用户明确要求联网或创意依赖缺失的时效信息、出处及具体外部事实时搜索。普通互动和通用笑点使用已给素材或原创。focus写待核实的事实或行为，不复述完整剧情；固定角色与创意由服务端提供。搜索失败或素材不适用时直接原创，不再搜索。",
            parameters: Type.Object(
                { focus: Type.Optional(Type.String({ maxLength: 200 })) },
                { additionalProperties: false },
            ),
            executionMode: "sequential",
            execute: async (_id, args, toolSignal) => {
                const searchStarted = Date.now();
                signal.throwIfAborted();
                if (!searchAllowed) throw new Error("本次创意未开放联网搜索");
                if (failed || repairing || ++calls > budget.maxSearchCalls) {
                    failed = true;
                    throw new Error("搜梗调用超过预算");
                }
                const finishSearch = (
                    result: MemeResearch,
                    error?: unknown,
                ) => {
                    completedSearches++;
                    research.push(result);
                    session.setActiveToolsByName([]);
                    report({
                        stage: "search",
                        outcome: result.status,
                        elapsedMs: Date.now() - searchStarted,
                        ...(result.status === "failed"
                            ? {
                                  code:
                                      error instanceof EmojiFailure
                                          ? error.code
                                          : "execution",
                                  ...(error instanceof EmojiFailure &&
                                  error.httpStatus !== undefined
                                      ? { httpStatus: error.httpStatus }
                                      : {}),
                              }
                            : {}),
                    });
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({
                                    research: researchForAgent(result),
                                }),
                            },
                        ],
                        details: {},
                    };
                };
                try {
                    const remaining = deadline - Date.now();
                    if (remaining <= 0)
                        throw new EmojiFailure("search", "timeout");
                    const result = await this.#options.search.search(
                        {
                            cast: brief.cast,
                            idea: brief.idea,
                            ...(args.focus ? { focus: args.focus } : {}),
                        },
                        {
                            signal: AbortSignal.any([
                                signal,
                                ...(toolSignal ? [toolSignal] : []),
                                AbortSignal.timeout(
                                    Math.max(
                                        1,
                                        Math.min(
                                            budget.searchTimeoutMs,
                                            Math.floor((remaining * 2) / 3),
                                        ),
                                    ),
                                ),
                            ]),
                            maxKeywords: budget.maxKeywords,
                            maxOutputTokens: budget.searchTokens,
                        },
                    );
                    signal.throwIfAborted();
                    return finishSearch(result);
                } catch (error) {
                    // 搜索自身失败或超时不阻止原创；用户取消和整体截止仍立即停止。
                    if (signal.aborted || toolSignal?.aborted) {
                        failed = true;
                        throw new EmojiFailure(
                            "search",
                            signal.aborted
                                ? cancellationCode(signal)
                                : "cancelled",
                            Date.now() - started,
                        );
                    }
                    return finishSearch(originalResearch(), error);
                }
            },
        });
        this.#model ??= createCharacterEmojiModel(this.#options);
        const supportKey = `${format}:${mode}:${budget.reasoningEffort}`;
        if (!this.#supports.has(supportKey)) {
            const skills = this.#options.skills.filter(
                (skill) =>
                    skill.name === "character-emoji-planner" ||
                    skill.name === `character-emoji-${mode}`,
            );
            if (
                skills.length !== 2 ||
                !skills.some(
                    (skill) => skill.name === "character-emoji-planner",
                ) ||
                !skills.some(
                    (skill) => skill.name === `character-emoji-${mode}`,
                )
            )
                throw new Error("表情包缺少公共或模式 Skill");
            this.#supports.set(
                supportKey,
                this.#model.then(
                    (modelRuntime) =>
                        new PiSessionSupport({
                            skills,
                            instructions: [
                                "执行角色表情包构思。默认直接提交方案，仅在已绑定 Skill 规定的必要情形使用搜索 Tool。",
                            ],
                            provider: characterEmojiProvider,
                            model: characterEmojiModel,
                            modelRuntime,
                            thinkingLevel:
                                budget.reasoningEffort === "none"
                                    ? "off"
                                    : "low",
                            sessionFactory: (options) =>
                                (
                                    this.#options.sessionFactory ??
                                    createAgentSession
                                )({
                                    ...options,
                                    settingsManager: SettingsManager.inMemory({
                                        retry: {
                                            enabled: false,
                                            provider: { maxRetries: 0 },
                                        },
                                        compaction: { enabled: false },
                                    }),
                                }),
                        }),
                ),
            );
        }
        const support = await this.#supports.get(supportKey);
        if (!support) throw new Error("表情包模式未绑定会话");
        signal.throwIfAborted();
        const session = await support.open(
            {
                noTools: "all",
                tools: searchAllowed ? [tool.name] : [],
                customTools: searchAllowed ? [tool] : [],
            },
            [
                searchAllowed
                    ? "本次允许核实用户要求的外部资料；已有材料足够时直接构思。"
                    : "本次使用本地素材或原创，直接提交方案；没有联网工具，不声称已检索或已核实实时资料。",
            ],
        );
        return withAbortableSession(session, signal, async () => {
            session.setAutoRetryEnabled(false);
            session.setAutoCompactionEnabled(false);
            let modelCalls = 0;
            let outcome: "succeeded" | "failed" = "failed";
            let source: AdaptationSource | undefined;
            const preparePayload = (payload: unknown) => {
                signal.throwIfAborted();
                if (failed || ++modelCalls > budget.maxModelCalls) {
                    failed = true;
                    throw new Error("表情包模型调用超过预算或检索失败");
                }
                if (
                    !payload ||
                    typeof payload !== "object" ||
                    Array.isArray(payload)
                )
                    throw new Error("模型请求格式无效");
                // 专用网关只接收本流程使用的 Responses 字段。
                const request = { ...payload } as Record<string, unknown>;
                delete request.prompt_cache_key;
                delete request.prompt_cache_retention;
                delete request.prompt_cache_options;
                return request;
            };
            session.agent.onPayload = (payload) => {
                const request = preparePayload(payload);
                if (
                    !searchAllowed ||
                    repairing ||
                    calls === budget.maxSearchCalls
                ) {
                    delete request.tools;
                    delete request.tool_choice;
                }
                if (!Array.isArray(request.input))
                    throw new Error("表情包模型输入格式无效");
                // 首轮也可能直接出稿；每轮提供当前来源合同，不增加专门的搜索判断请求。
                request.input = [
                    ...request.input,
                    {
                        role: "system",
                        content: `提交时只返回符合以下 JSON Schema 的完整方案对象：${JSON.stringify(z.toJSONSchema(schema()))}`,
                    },
                ];
                return {
                    ...request,
                    text: { format: { type: "json_object" } },
                    max_output_tokens: budget.planTokens,
                    reasoning: {
                        effort: repairing ? "none" : budget.reasoningEffort,
                    },
                };
            };
            const assertCompleted = () => {
                signal.throwIfAborted();
                if (failed || completedSearches !== calls)
                    throw new Error("表情包搜索调用未完成或超过预算");
                const final = session.messages.findLast(
                    (message) => message.role === "assistant",
                );
                if (
                    !final ||
                    !("stopReason" in final) ||
                    final.stopReason !== "stop"
                )
                    throw new EmojiFailure(
                        "planning",
                        final &&
                            "stopReason" in final &&
                            final.stopReason === "error"
                            ? "model_error"
                            : "incomplete_response",
                        Date.now() - started,
                    );
            };
            const outputText = () => {
                const last = session.messages.findLast(
                    (message) => message.role === "assistant",
                );
                if (last?.role !== "assistant" || last.stopReason !== "stop")
                    throw new Error("表情包构思响应缺失");
                const blocks = last.content.filter(
                    (part) => part.type === "text",
                );
                const finals = blocks.filter(
                    (part) => textPhase(part.textSignature) === "final_answer",
                );
                // Pi 将同次 Responses 的多个 message 合并为文本块，按签名保留最终正文。
                const content = finals.length
                    ? finals
                    : blocks.filter(
                          (part) =>
                              textPhase(part.textSignature) !== "commentary",
                      );
                if (!content.some((part) => part.text.trim()))
                    throw new EmojiFailure(
                        "planning",
                        "empty_response",
                        Date.now() - started,
                    );
                try {
                    return JSON.stringify(
                        parseAgentJson([{ ...last, content }]),
                    );
                } catch (error) {
                    // 保留原 Memebuy 解析器对单层完整 JSON 围栏的兼容。
                    if (error instanceof AgentJsonSyntaxError)
                        return error.responseText;
                    throw error;
                }
            };
            const readOutput = () => {
                const text = outputText();
                try {
                    return readPlannerJson(text);
                } catch {
                    throw new EmojiFailure(
                        "planning",
                        "invalid_json",
                        Date.now() - started,
                    );
                }
            };
            const schemaFailure = (error: z.ZodError) =>
                new EmojiFailure(
                    "planning",
                    error.issues.some(
                        (issue) =>
                            issue.path[0] === "adaptation" &&
                            (issue.path[1] === "entryId" ||
                                issue.path[1] === "entryIds"),
                    )
                        ? "invalid_source"
                        : "invalid_schema",
                    Date.now() - started,
                    undefined,
                    planningIssues(error.issues),
                );
            const prompt = async (text: string) => {
                try {
                    await session.prompt(text, {
                        expandPromptTemplates: false,
                    });
                } catch (error) {
                    if (signal.aborted)
                        throw new EmojiFailure(
                            "planning",
                            cancellationCode(signal),
                            Date.now() - started,
                        );
                    const last = session.messages.findLast(
                        (message) => message.role === "assistant",
                    );
                    // Pi 可能在写入失败消息后直接抛出，不能因此丢失模型失败分类。
                    if (
                        last?.role === "assistant" &&
                        last.stopReason === "error"
                    )
                        throw new EmojiFailure(
                            "planning",
                            "model_error",
                            Date.now() - started,
                        );
                    throw error;
                }
            };
            const repair = async (text: string) => {
                repairing = true;
                session.setActiveToolsByName([]);
                await prompt(text);
                assertCompleted();
            };
            const businessFailure = (failure: AiTextOutputFailure) =>
                new EmojiFailure(
                    "planning",
                    "business_validation",
                    Date.now() - started,
                    undefined,
                    planningIssues(
                        (failure.issues ?? []).map((issue) => ({
                            ...issue,
                            path: issue.path.split("."),
                        })),
                    ),
                );
            const plannerBrief = JSON.parse(input);
            try {
                await prompt(
                    JSON.stringify({
                        mode,
                        ...plannerBrief,
                        ...(format === "scene"
                            ? {
                                  localMemes: memesForAgent(local),
                              }
                            : {}),
                    }),
                );
                assertCompleted();
                let raw: unknown;
                try {
                    raw = readOutput();
                } catch (error) {
                    if (
                        !(error instanceof EmojiFailure) ||
                        error.code !== "invalid_json"
                    )
                        throw error;
                    await repair(JSON_CORRECTION_PROMPT);
                    raw = readOutput();
                }
                let accepted = schema().safeParse(raw);
                if (!accepted.success) {
                    if (repairing) throw schemaFailure(accepted.error);
                    const correction = createSchemaCorrection(
                        raw,
                        accepted.error,
                    );
                    if (!correction) throw schemaFailure(accepted.error);
                    await repair(correction.prompt);
                    raw = readOutput();
                    correction.assertUnchanged(raw);
                    accepted = schema().safeParse(raw);
                    if (!accepted.success) throw schemaFailure(accepted.error);
                }
                const { candidate, plan } = accept(raw);
                const result = parse(JSON.stringify(plan));
                if (result.success) {
                    outcome = "succeeded";
                    source = adaptationSource(candidate.adaptation, local);
                    return result.plan;
                }
                const correction = createCorrection(candidate, result);
                if (!correction || repairing) throw businessFailure(result);
                await repair(correction.prompt);
                const correctedRaw = readOutput();
                const correctedResult = schema().safeParse(correctedRaw);
                if (!correctedResult.success)
                    throw schemaFailure(correctedResult.error);
                const corrected = accept(correctedRaw);
                correction.assertUnchanged(corrected.candidate);
                const checked = parse(JSON.stringify(corrected.plan));
                if (!checked.success) throw businessFailure(checked);
                outcome = "succeeded";
                source = adaptationSource(
                    corrected.candidate.adaptation,
                    local,
                );
                return checked.plan;
            } finally {
                if (calls === 0 && outcome === "succeeded") {
                    report({
                        stage: "search",
                        outcome: "skipped",
                        elapsedMs: 0,
                    });
                }
                report({
                    stage: "planning",
                    outcome,
                    elapsedMs: Date.now() - started,
                    modelCalls,
                    repairAttempts: Number(repairing),
                    ...(source ? { source } : {}),
                    ...(format === "scene"
                        ? {
                              libraryVersion: memeLibraryVersion,
                              localCandidates: local.length,
                          }
                        : {}),
                });
            }
        });
    }
}

function textPhase(signature: string | undefined): string | undefined {
    if (!signature) return undefined;
    try {
        const value = JSON.parse(signature);
        return value?.v === 1 && typeof value.id === "string"
            ? value.phase
            : undefined;
    } catch {
        return undefined;
    }
}
