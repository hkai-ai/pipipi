import { describe, expect, it } from "vitest";
import { characterPersonas } from "../src/processes/character-emoji/character-personas.js";
import { comicPlannerInput } from "../src/processes/character-emoji/comic-prompt.js";
import { createSchemaCorrection } from "../src/processes/character-emoji/correction.js";
import { plannerInput } from "../src/processes/character-emoji/prompt.js";
import {
    acceptSceneCandidate,
    parseSceneComicPlan,
    parseScenePlan,
    projectSceneCandidate,
    sceneCandidateSchema,
    sceneComicPlanSchema,
    scenePlanSchema,
} from "../src/processes/character-emoji/scene.js";
import {
    SCENE_PLANNER_RULES,
    sceneComicImagePrompt,
    sceneImagePrompt,
} from "../src/processes/character-emoji/scene-prompt.js";
import {
    briefSchema,
    comicBriefSchema,
} from "../src/processes/character-emoji/schema.js";

const brief = briefSchema.parse({
    cast: [
        { character: "DeepSeek", appearance: "Chibi" },
        { character: "Claude", appearance: "Girl" },
    ],
    idea: "压缩记忆后忘了任务",
    captionSetting: { mode: "none" },
});
const actors = brief.cast.map(({ character }) => ({
    character,
    identityMark: null,
}));
const scene =
    "左边DeepSeek双手捧着封闭的记忆箱，茫然望向右边Claude；Claude用右手指向桌上的未完拼图，左手扶额。";
const single = { scene, actors, caption: "", propMarks: [] };
const adaptation = { entryIds: [], original: "按需求原创" };
const comic = () =>
    sceneComicPlanSchema.parse(
        projectSceneCandidate(
            acceptSceneCandidate(
                {
                    page: {
                        aspectRatio: "2:1",
                        layout: "左侧大格占四分之三，右上嵌入反应小格",
                        readingOrder: "先左侧大格1，再右上小格2",
                    },
                    panels: [
                        {
                            frame: "左侧大格占四分之三画幅",
                            scene,
                            actors,
                            texts: [],
                        },
                        {
                            frame: "右上嵌格，占四分之一画幅",
                            scene: "箱子放在桌后；DeepSeek用右手拆掉刚完成的拼图，Claude双手抱头。",
                            actors,
                            texts: [],
                        },
                    ],
                    adaptation,
                },
                "comic",
                [],
            ),
        ),
    );

describe("每格唯一场景合同", () => {
    it("公共规则要求动作与结果表达因果，不引入剧情模板或新字段", () => {
        expect(SCENE_PLANNER_RULES).toContain("让观众看见谁对什么做了什么");
        expect(SCENE_PLANNER_RULES).toContain("决定反差的行为留在画面里");
        expect(SCENE_PLANNER_RULES).toContain(
            "先后动作分到不同格，单图只留关键瞬间",
        );
        expect(SCENE_PLANNER_RULES).not.toMatch(/椅腿|积木|记忆笔记/);
        expect(Object.keys(scenePlanSchema.shape)).toEqual([
            "scene",
            "actors",
            "caption",
            "propMarks",
        ]);
    });
    it("角色背景按选择身份原样注入单图与漫画，不进入成图指令", () => {
        for (const [character, background] of Object.entries(
            characterPersonas,
        )) {
            const input = briefSchema.parse({
                cast: [{ character, appearance: "Chibi" }],
                idea: "合作完成任务",
            });
            expect(JSON.parse(plannerInput(input)).cast[0].creativeBrief).toBe(
                background,
            );
            expect(
                JSON.parse(
                    comicPlannerInput({
                        ...input,
                        mode: "comic",
                        captionSetting: undefined,
                    }),
                ).cast[0].creativeBrief,
            ).toBe(background);
        }
        expect(Object.keys(characterPersonas)).toHaveLength(11);
        expect(sceneImagePrompt(brief, single)).not.toContain(
            characterPersonas.DeepSeek,
        );
    });
    it("布局字段可在原预算内单独修正，场景与其他布局冻结", () => {
        const plan = comic();
        const raw = {
            ...plan,
            panels: plan.panels.map(({ index: _index, ...panel }) => panel),
            adaptation,
        };
        const invalid = { ...raw, page: { ...raw.page, layout: "" } };
        const result = sceneCandidateSchema("comic", []).safeParse(invalid);
        if (result.success) throw new Error("空布局应失败");
        const correction = createSchemaCorrection(invalid, result.error);
        if (!correction) throw new Error("应提供布局修正");
        expect(() => correction.assertUnchanged(raw)).not.toThrow();
        expect(() =>
            correction.assertUnchanged({
                ...raw,
                panels: raw.panels.map((p) => ({ ...p, scene: "改写剧情" })),
            }),
        ).toThrow();
        const missingFrame = {
            ...raw,
            panels: raw.panels.map((p, i) => (i ? p : { ...p, frame: "" })),
        };
        const frameResult = sceneCandidateSchema("comic", []).safeParse(
            missingFrame,
        );
        if (frameResult.success) throw new Error("空画格应失败");
        const frameCorrection = createSchemaCorrection(
            missingFrame,
            frameResult.error,
        );
        if (!frameCorrection) throw new Error("应提供画格修正");
        expect(() => frameCorrection.assertUnchanged(raw)).not.toThrow();
    });
    it("单图不复制动作、构图和笑点", () => {
        expect(
            projectSceneCandidate(
                acceptSceneCandidate({ ...single, adaptation }, "single", []),
            ),
        ).toEqual(single);
        for (const key of [
            "joke",
            "composition",
            "punchlineDetail",
            "continuity",
        ])
            expect(
                scenePlanSchema.safeParse({ ...single, [key]: "重复事实" })
                    .success,
            ).toBe(false);
        expect(
            scenePlanSchema.safeParse({
                ...single,
                actors: [{ ...actors[0], action: "另一动作" }, actors[1]],
            }).success,
        ).toBe(false);
        const prompt = sceneImagePrompt(brief, single);
        expect(prompt.split(scene)).toHaveLength(2);
        expect(prompt).not.toContain("创作意图");
    });
    it("漫画只生成编号，完整保留自由布局、嵌格和场景", () => {
        const plan = comic();
        expect(plan.panels.map((p) => p.index)).toEqual([1, 2]);
        expect(plan.page.layout).toBe("左侧大格占四分之三，右上嵌入反应小格");
        expect(plan.page.readingOrder).toBe("先左侧大格1，再右上小格2");
        expect(plan.panels[1].frame).toBe("右上嵌格，占四分之一画幅");
        expect(plan.panels[0].scene).toBe(scene);
        expect(Object.keys(plan).sort()).toEqual(["page", "panels"]);
        const prompt = sceneComicImagePrompt(
            comicBriefSchema.parse({
                ...brief,
                captionSetting: undefined,
                mode: "comic",
            }),
            plan,
        );
        expect(prompt).toContain(plan.page.layout);
        expect(prompt).toContain(plan.page.readingOrder);
        expect(prompt).not.toContain("无额外封面、标题格或嵌格");
        for (const panel of plan.panels) {
            expect(prompt.split(panel.scene)).toHaveLength(2);
            expect(prompt).toContain(panel.frame);
        }
    });
    it("按ID绑定角色，错序允许，缺失、重复和额外角色拒绝", () => {
        expect(
            parseScenePlan(
                JSON.stringify({ ...single, actors: [...actors].reverse() }),
                brief,
            ).success,
        ).toBe(true);
        for (const invalid of [
            [actors[0]],
            [actors[0], actors[0]],
            [actors[0], { character: "Gemini", identityMark: null }],
        ])
            expect(
                parseScenePlan(
                    JSON.stringify({ ...single, actors: invalid }),
                    brief,
                ).success,
            ).toBe(false);
    });
    it("保留准确配字与明确无字要求", () => {
        const custom = {
            ...brief,
            captionSetting: { mode: "custom" as const, text: "记忆已清空" },
        };
        expect(parseScenePlan(JSON.stringify(single), custom).success).toBe(
            false,
        );
        expect(
            parseScenePlan(
                JSON.stringify({ ...single, caption: "记忆已清空" }),
                custom,
            ).success,
        ).toBe(true);
        expect(
            parseScenePlan(
                JSON.stringify({ ...single, caption: "记忆已清空" }),
                { ...custom, idea: "禁止任何文字" },
            ).success,
        ).toBe(false);
        const plan = comic();
        plan.panels[0].texts = [
            {
                kind: "dialogue",
                speaker: "DeepSeek",
                text: "我忘了",
                placement: "头顶",
            },
        ];
        const input = comicBriefSchema.parse({
            mode: "comic",
            cast: brief.cast,
            idea: "禁止任何文字",
        });
        expect(parseSceneComicPlan(JSON.stringify(plan), input).success).toBe(
            false,
        );
        plan.panels[0].actors = [actors[1]];
        expect(
            parseSceneComicPlan(JSON.stringify(plan), {
                ...input,
                idea: "压缩记忆",
            }).success,
        ).toBe(false);
    });
    it("同次来源约束仍在，来源和改编说明不进入公开方案", () => {
        expect(() =>
            acceptSceneCandidate(
                {
                    ...single,
                    adaptation: { ...adaptation, entryIds: ["other-run"] },
                },
                "single",
                [],
            ),
        ).toThrow();
        expect(
            projectSceneCandidate(
                acceptSceneCandidate({ ...single, adaptation }, "single", []),
            ),
        ).not.toHaveProperty("adaptation");
    });
    it("场景长度错误只允许修改该场景，其他字段冻结", () => {
        const raw = { ...single, scene: "长".repeat(1601), adaptation };
        const result = sceneCandidateSchema("single", []).safeParse(raw);
        if (result.success) throw new Error("长场景应失败");
        const correction = createSchemaCorrection(raw, result.error);
        if (!correction) throw new Error("应提供场景修正");
        expect(() =>
            correction.assertUnchanged({ ...raw, scene }),
        ).not.toThrow();
        expect(() =>
            correction.assertUnchanged({ ...raw, scene, caption: "改动" }),
        ).toThrow();
    });
});
