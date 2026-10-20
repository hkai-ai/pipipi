import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    acceptCandidate,
    candidateSchema,
    comicCandidateSchema,
    projectCandidate,
    singleCandidateSchema,
    validateAdaptation,
} from "../src/processes/character-emoji/candidate.js";
import { fixedComicLayout } from "../src/processes/character-emoji/comic-layout.js";
import { createCorrection } from "../src/processes/character-emoji/correction.js";
import type { ComicPlan } from "../src/processes/character-emoji/schema.js";
import {
    bindResearch,
    researchForAgent,
} from "../src/processes/character-emoji/search.js";

const entry = {
    kind: "community_secondary" as const,
    summary: "转述网友遇到模型称呼变化",
    behavior: "把熟人称作用户",
    expectation: "记得称呼",
    contrast: "机械接待",
    sourceUrl: "https://example.org/source",
};
const sources = [
    {
        title: "原帖",
        url: entry.sourceUrl,
        excerpt: "网友遇到模型把熟人称作用户",
    },
];
const research = [
    bindResearch({ entries: [entry], insufficiency: "未核验原帖" }, sources),
];
const candidate = singleCandidateSchema.parse({
    caption: "用户，请描述需求",
    joke: "忘记熟人",
    actors: [
        {
            character: "DeepSeek",
            action: "对熟人机械接待",
            expression: "茫然",
            position: "中央",
            identityMark: null,
        },
    ],
    propMarks: [],
    composition: "平视柜台，人物与空白座位分居两侧",
    punchlineDetail: "角色对熟客摆出陌生接待姿势",
    adaptation: {
        entryId: research[0].entries[0].id,
        original: "机械接待姿势为原创",
    },
});
describe("改编来源和画面事实", () => {
    it("资料投影有界且不改变完整资料、来源ID和资格", () => {
        const full = bindResearch(
            {
                entries: [{ ...entry, summary: "行为反差".repeat(900) }],
                insufficiency: "不足".repeat(400),
            },
            [{ ...sources[0], excerpt: "原生引用".repeat(4000) }],
        );
        const before = structuredClone(full);
        const compact = researchForAgent(full);
        expect(compact.entries[0].summary).toHaveLength(800);
        expect(compact.entries[0].sourceQuote).toHaveLength(1200);
        expect(compact.text).toHaveLength(400);
        expect(compact.entries[0].id).toBe(full.entries[0].id);
        expect(compact.entries[0].verification).toBe("cited");
        expect(compact.entries[0]).not.toHaveProperty("sourceUrl");
        expect(full).toEqual(before);
    });
    it("相同摘要与原生引用不重复传入Agent", () => {
        const full = bindResearch({ entries: [entry], insufficiency: "" }, [
            {
                ...sources[0],
                excerpt: [
                    entry.summary,
                    entry.behavior,
                    entry.expectation,
                    entry.contrast,
                ].join("\n"),
            },
        ]);
        expect(researchForAgent(full).entries[0]).not.toHaveProperty(
            "sourceQuote",
        );
        expect(full.entries[0].sourceQuote).not.toBe("");
    });
    it("漫画请求 Schema 使用供应商支持的联合结构且保留说话者约束", () => {
        const schema = z.toJSONSchema(candidateSchema("comic", []));
        expect(JSON.stringify(schema)).not.toContain('"oneOf"');
        const text =
            comicCandidateSchema.shape.panels.element.shape.texts.element;
        const dialogue = {
            kind: "dialogue",
            speaker: "DeepSeek",
            text: "忘了任务",
            placement: "头顶",
        };
        expect(text.safeParse(dialogue).success).toBe(true);
        expect(text.safeParse({ ...dialogue, speaker: null }).success).toBe(
            false,
        );
        expect(text.safeParse({ ...dialogue, kind: "narration" }).success).toBe(
            false,
        );
        expect(
            text.safeParse({ ...dialogue, kind: "narration", speaker: null })
                .success,
        ).toBe(true);
    });
    it("缺引用的资料保留但明确未核验，背景与不足不能冒充社区梗", () => {
        expect(
            bindResearch({ entries: [entry], insufficiency: "" }, []).entries,
        ).toEqual([
            expect.objectContaining({
                verification: "unverified",
                sourceQuote: "",
            }),
        ]);
        const background = bindResearch(
            {
                entries: [
                    {
                        ...entry,
                        kind: "background",
                        behavior: "",
                        expectation: "",
                        contrast: "",
                    },
                ],
                insufficiency: "Claude抱清单没有可靠素材",
            },
            sources,
        );
        expect(() =>
            validateAdaptation(
                {
                    ...candidate,
                    adaptation: {
                        ...candidate.adaptation,
                        entryId: background.entries[0].id,
                    },
                },
                [background],
            ),
        ).toThrow();
        expect(() =>
            validateAdaptation(
                {
                    ...candidate,
                    adaptation: {
                        ...candidate.adaptation,
                        entryId: "insufficiency",
                    },
                },
                research,
            ),
        ).toThrow();
        expect(() =>
            bindResearch(
                { entries: [{ ...entry, behavior: "" }], insufficiency: "" },
                sources,
            ),
        ).not.toThrow();
    });
    it("请求Schema和本地提交校验均绑定同次来源", () => {
        expect(candidateSchema("single", []).safeParse(candidate).success).toBe(
            false,
        );
        expect(() => acceptCandidate(candidate, "single", [])).toThrow();
        expect(acceptCandidate(candidate, "single", research)).toEqual(
            candidate,
        );
    });
    it("原生摘要由服务端直接绑定，不接受模型拼接摘录或不足说明", () => {
        const bound = bindResearch(
            { entries: [entry], insufficiency: "" },
            sources,
        );
        expect(bound.status).toBe("usable");
        expect(bound.entries[0].sourceQuote).toBe(sources[0].excerpt);
        expect(
            bindResearch(
                {
                    entries: [{ ...entry, sourceQuote: "拼接……句子" }],
                    insufficiency: "",
                },
                sources,
            ).entries[0].sourceQuote,
        ).toBe(sources[0].excerpt);
        expect(
            bindResearch({ entries: [entry], insufficiency: "" }, [
                { title: "原帖", url: entry.sourceUrl },
            ]).status,
        ).toBe("unverifiable");
        expect(
            bindResearch(
                { entries: [], insufficiency: "没有合适素材" },
                sources,
            ).status,
        ).toBe("insufficient");
    });
    it("来源身份必须有效，原创候选不需要伪造路径", () => {
        expect(acceptCandidate(candidate, "single", research)).toEqual(
            candidate,
        );
        expect(() =>
            validateAdaptation(
                {
                    ...candidate,
                    adaptation: { ...candidate.adaptation, entryId: "fake" },
                },
                research,
            ),
        ).toThrow();
        expect(() =>
            validateAdaptation(
                {
                    ...candidate,
                    adaptation: { entryId: null, original: "按用户需求原创" },
                },
                [],
            ),
        ).not.toThrow();
        expect(
            singleCandidateSchema.safeParse({
                ...candidate,
                adaptation: { ...candidate.adaptation, uses: ["caption"] },
            }).success,
        ).toBe(false);
    });
    it("修正仅允许已报告台词，角色、来源与画面保持原值", () => {
        const correction = createCorrection(candidate, {
            reason: "invalid_schema",
            issues: [{ path: "caption", code: "caption_setting_mismatch" }],
        });
        if (!correction) throw new Error("缺少修正合同");
        expect(() =>
            correction.assertUnchanged({ ...candidate, caption: "请描述需求" }),
        ).not.toThrow();
        for (const changed of [
            { ...candidate, composition: "全新场景" },
            {
                ...candidate,
                adaptation: { ...candidate.adaptation, entryId: null },
            },
            {
                ...candidate,
                actors: [
                    { ...candidate.actors[0], character: "Claude" as const },
                ],
            },
        ])
            expect(() => correction.assertUnchanged(changed)).toThrow();
    });
    it("修正后仍校验来源，不因同一会话而信任新ID", () => {
        expect(() =>
            acceptCandidate(
                {
                    ...candidate,
                    adaptation: { ...candidate.adaptation, entryId: "fake" },
                },
                "single",
                research,
            ),
        ).toThrow();
        expect(() =>
            acceptCandidate(
                {
                    ...candidate,
                    adaptation: { ...candidate.adaptation, entryId: null },
                },
                "single",
                [],
            ),
        ).not.toThrow();
    });
    it("画面细节由Agent提供，公开投影不填默认笑点", () => {
        const plan = projectCandidate(candidate);
        expect(plan).toHaveProperty("composition", candidate.composition);
        expect(plan).toHaveProperty(
            "punchlineDetail",
            candidate.punchlineDetail,
        );
        expect(plan).not.toHaveProperty("adaptation");
        expect(
            singleCandidateSchema.safeParse({ ...candidate, shot: "中景" })
                .success,
        ).toBe(false);
    });
    it("缺失结构不补造，也不允许修复非配字业务错误", () => {
        expect(() => acceptCandidate({ caption: "" }, "single", [])).toThrow();
        expect(
            createCorrection(candidate, {
                reason: "invalid_schema",
                issues: [{ path: "actors", code: "cast_mismatch" }],
            }),
        ).toBeNull();
    });
    it("指定配字错误只允许修正caption，其余内容冻结", () => {
        const correction = createCorrection(candidate, {
            reason: "invalid_schema",
            issues: [{ path: "caption", code: "caption_setting_mismatch" }],
        });
        if (!correction) throw new Error("缺少配字修正");
        expect(() =>
            correction.assertUnchanged({ ...candidate, caption: "指定原文" }),
        ).not.toThrow();
        expect(() =>
            correction.assertUnchanged({ ...candidate, joke: "新的故事" }),
        ).toThrow();
    });
});

describe("漫画固定布局", () => {
    it.each([2, 3, 4, 5, 6])(
        "%i格的整页与独立格子一致，重复投影不变化",
        (count) => {
            const original = {
                joke: "反差",
                continuity: "桌旁",
                page: {
                    aspectRatio: "2:3",
                    layout: "通栏且右侧嵌格",
                    readingOrder: "混乱",
                },
                panels: Array.from({ length: count }, (_, index) => ({
                    index: index + 1,
                    frame: "占半页的通栏",
                    actors: candidate.actors,
                    composition: "桌旁",
                    texts: [],
                    punchlineDetail: "清单",
                })),
            } as ComicPlan;
            const plan = fixedComicLayout(original);
            expect(fixedComicLayout(plan)).toEqual(plan);
            expect(plan.panels).toHaveLength(count);
            expect(new Set(plan.panels.map((panel) => panel.frame)).size).toBe(
                count,
            );
            expect(plan.page.layout).toContain("无嵌格或重叠");
            expect(plan.panels[0].actors).toEqual(original.panels[0].actors);
            if (count === 5) expect(plan.panels[4].frame).toContain("宽度1/1");
        },
    );
});
