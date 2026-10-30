import { describe, expect, it } from "vitest";
import {
    comicCandidateSchema,
    projectCandidate,
} from "../src/processes/character-emoji/candidate.js";
import { parseComicPlannerOutput } from "../src/processes/character-emoji/comic-output.js";
import { comicImagePrompt } from "../src/processes/character-emoji/comic-prompt.js";
import { createCorrection } from "../src/processes/character-emoji/correction.js";
import type {
    ComicBrief,
    ComicPlan,
} from "../src/processes/character-emoji/schema.js";

const brief: ComicBrief = {
    mode: "comic",
    cast: [{ character: "DeepSeek", appearance: "Chibi" }],
    idea: "打包后忘记任务",
};
const candidate = (): ComicPlan => ({
    joke: "打包后忘记任务",
    continuity: "桌上始终有封好的档案袋",
    page: {
        aspectRatio: "2:3",
        layout: "上下两行各占一半",
        readingOrder: "从上到下",
    },
    panels: [1, 1].map((index) => ({
        index,
        frame: "独立横格，占内容区一半高度",
        actors: [
            {
                character: "DeepSeek",
                expression: "看着袋子",
                action: "双手抱袋",
                position: "居中",
                identityMark: null,
            },
        ],
        composition: "平视中景",
        texts: [
            {
                kind: "dialogue",
                speaker: "DeepSeek",
                text: "我忘了",
                placement: "头顶",
            },
        ],
        punchlineDetail: "袋子始终封好",
    })),
});
function internal() {
    const plan = candidate();
    return comicCandidateSchema.parse({
        joke: plan.joke,
        continuity: plan.continuity,
        aspectRatio: plan.page.aspectRatio,
        panels: plan.panels.map(
            ({ index: _index, frame: _frame, ...panel }) => panel,
        ),
        adaptation: { entryId: null, original: "按需求原创" },
    });
}
describe("漫画文字与投影", () => {
    it("编号由程序生成，自然台词直接通过", () => {
        const value = internal();
        const plan = projectCandidate(value) as ComicPlan;
        expect(plan.panels.map((panel) => panel.index)).toEqual([1, 2]);
        expect(
            parseComicPlannerOutput(JSON.stringify(plan), brief).success,
        ).toBe(true);
        expect(plan.continuity).toBe(value.continuity);
        expect(comicImagePrompt(brief, plan)).toContain("我忘了");
    });
    it.each(["composition", "punchlineDetail", "continuity"])(
        "投影保留Agent创作的%s",
        (field) => {
            const value = internal();
            const plan = projectCandidate(value) as ComicPlan;
            if (field === "continuity")
                expect(plan.continuity).toBe(value.continuity);
            else if (field === "composition")
                expect(plan.panels[0].composition).toBe(
                    value.panels[0].composition,
                );
            else
                expect(plan.panels[0].punchlineDetail).toBe(
                    value.panels[0].punchlineDetail,
                );
        },
    );
    it("允许你我和只改一行，明确无字或无对白仍生效", () => {
        const value = internal();
        value.panels[0].texts[0].text = "我只改一行，你看呢";
        const plan = projectCandidate(value) as ComicPlan;
        expect(
            parseComicPlannerOutput(JSON.stringify(plan), brief).success,
        ).toBe(true);
        expect(comicImagePrompt(brief, plan)).toContain("可根据场景补充少量");
        for (const idea of ["不要任何文字", "不要对白"]) {
            const constrained = { ...brief, idea };
            expect(
                parseComicPlannerOutput(JSON.stringify(plan), constrained)
                    .success,
            ).toBe(false);
            const silent = {
                ...plan,
                panels: plan.panels.map((panel) => ({ ...panel, texts: [] })),
            };
            expect(
                parseComicPlannerOutput(JSON.stringify(silent), constrained)
                    .success,
            ).toBe(true);
            const prompt = comicImagePrompt(constrained, silent);
            expect(prompt).toContain(
                idea === "不要对白" ? "用户要求无对白" : "用户要求禁止任何文字",
            );
            if (idea === "不要任何文字")
                expect(prompt).not.toContain("可根据场景补充");
        }
    });
    it("角色错误不能借台词修正绕过", () => {
        const value = internal();
        value.panels[0].actors[0].character = "Claude";
        const result = parseComicPlannerOutput(
            JSON.stringify(projectCandidate(value)),
            brief,
        );
        if (result.success) throw new Error("未拒绝名单外角色");
        expect(createCorrection(value, result)).toBeNull();
    });
    it("结构缺失或多余字段直接失败，不补造剧情", () => {
        expect(() =>
            comicCandidateSchema.parse({ ...internal(), extra: "说明" }),
        ).toThrow();
        const value = internal();
        value.panels[0].composition = "";
        expect(() => comicCandidateSchema.parse(value)).toThrow();
    });
});
