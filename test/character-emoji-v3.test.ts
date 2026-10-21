import { describe, expect, it, vi } from "vitest";
import { createProcessExecutor } from "../src/processes/catalog.js";
import type { CharacterEmojiRenderingCapability } from "../src/processes/character-emoji/capability.js";
import { versionedInputSchema } from "../src/processes/character-emoji/cast.js";
import { imageUrl } from "../src/processes/character-emoji/catalog.js";
import { createCharacterEmojiRegistration } from "../src/processes/character-emoji/registration.js";
import {
    acceptSceneCandidate,
    projectSceneCandidate,
    versionedSceneComicPlanSchema,
} from "../src/processes/character-emoji/scene.js";

const cast = [
    { character: "Claude", appearance: "Chibi" },
    { character: "Claude", appearance: "Girl" },
] as const;
const actors = cast.map((member) => ({ ...member, identityMark: null }));
const single = {
    actors,
    scene: "两个版本面对面比身高",
    caption: "比比身高",
    propMarks: [],
};
const comic = versionedSceneComicPlanSchema.parse({
    page: { aspectRatio: "2:3", layout: "上大下小", readingOrder: "从上到下" },
    panels: actors.map((actor, index) => ({
        index: index + 1,
        frame: index ? "下方小格" : "上方大格",
        scene: "角色在身高尺旁站直",
        actors: [actor],
        texts: [
            {
                kind: "dialogue",
                speaker: `Claude:${actor.appearance}`,
                text: "轮到这个版本",
                placement: "头顶",
            },
        ],
    })),
});
const image = {
    url: "https://example.test/result.png",
    contentType: "image/png" as const,
    width: 1024,
    height: 1536,
};
function harness(plan = comic) {
    const render = vi.fn<CharacterEmojiRenderingCapability["render"]>(
        async () => image,
    );
    const agent = {
        planScene: vi.fn(async () => single),
        planSceneComic: vi.fn(async () => plan),
    };
    const executor = createProcessExecutor({
        registrations: [
            createCharacterEmojiRegistration({
                version: "v2",
                agent,
                capability: { render },
            }),
            createCharacterEmojiRegistration({
                version: "v3",
                agent,
                capability: { render },
            }),
        ],
    });
    return { executor, render, agent };
}

describe("双版本角色 v3 功能验收，不调用外部服务", () => {
    it.each(["single", "comic"])(
        "%s 经实际 Runner 保留身份并按 cast 顺序传两张参考图",
        async (mode) => {
            const h = harness();
            const input = {
                ...(mode === "comic"
                    ? { mode }
                    : { captionSetting: { mode: "custom", text: "比比身高" } }),
                cast,
                idea: "两个版本面对面比身高",
            };
            const result = await h.executor.execute({
                process: "character-emoji",
                version: "v3",
                input,
            });
            expect(result.status).toBe("succeeded");
            if (result.status !== "succeeded")
                throw new Error(JSON.stringify(result));
            expect(result.output).toMatchObject({
                mode,
                plan: mode === "comic" ? comic : single,
            });
            expect(h.render).toHaveBeenCalledOnce();
            const request = h.render.mock.calls[0]?.[0] as unknown as {
                imageUrls: string[];
                prompt: string;
            };
            expect(request.imageUrls).toEqual(
                cast.map((member) =>
                    imageUrl(member.character, member.appearance, "v3"),
                ),
            );
            expect(request.imageUrls[0]).toContain("/scenes/claude/");
            expect(imageUrl("Claude", "Chibi")).not.toContain("/scenes/");
            expect(new Set(request.imageUrls).size).toBe(2);
            expect(request.prompt).toContain("参考图1只对应Claude:Chibi");
            expect(request.prompt).toContain("参考图2只对应Claude:Girl");
            if (mode === "comic") {
                expect(request.prompt).toContain("Claude:Chibi的对白");
                expect(request.prompt).toContain("Claude:Girl的对白");
            }
        },
    );
    it("拒绝重复、超过五位以及把双版本误交给旧 v2，拒绝时不构思不生图", async () => {
        const h = harness();
        for (const [version, members] of [
            ["v3", [cast[0], cast[0]]],
            ["v3", [...cast, ...cast, ...cast]],
            ["v2", cast],
        ] as const) {
            const result = await h.executor.execute({
                process: "character-emoji",
                version,
                input: { cast: members, idea: "比身高" },
            });
            expect(result).toMatchObject({
                status: "failed",
                error: { code: "INVALID_INPUT" },
            });
        }
        expect(h.agent.planScene).not.toHaveBeenCalled();
        expect(h.render).not.toHaveBeenCalled();
        const five = [
            ...cast,
            { character: "DeepSeek", appearance: "Chibi" },
            { character: "DeepSeek", appearance: "Girl" },
            { character: "Grok", appearance: "Chibi" },
        ];
        expect(
            versionedInputSchema.safeParse({ cast: five, idea: "合影" })
                .success,
        ).toBe(true);
        expect(
            versionedInputSchema.safeParse({
                cast: [...five, { character: "Grok", appearance: "Girl" }],
                idea: "合影",
            }).success,
        ).toBe(false);
    });
    it("对白串到未登场版本时在生图前阻断", async () => {
        const wrong = structuredClone(comic);
        wrong.panels[0].texts[0].speaker = "Claude:Girl";
        const h = harness(wrong);
        const result = await h.executor.execute({
            process: "character-emoji",
            version: "v3",
            input: { mode: "comic", cast, idea: "比身高" },
        });
        expect(result).toMatchObject({
            status: "failed",
            error: { code: "AGENT_FAILURE" },
        });
        expect(h.render).not.toHaveBeenCalled();
    });
    it("候选方案投影不会丢失版本和对白身份", () => {
        const raw = {
            ...comic,
            panels: comic.panels.map(({ index: _index, ...panel }) => panel),
            adaptation: { entryIds: [], original: "按需求原创" },
        };
        expect(
            projectSceneCandidate(
                acceptSceneCandidate(raw, "comic", [], [], true),
            ),
        ).toEqual(comic);
    });
});

describe("v3 背景和画布选择", () => {
    it.each([
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9",
        "1:2",
        "2:1",
    ] as const)("单图与漫画使用 %s，背景原样传入渲染", async (aspectRatio) => {
        for (const mode of ["single", "comic"]) {
            const h = harness({
                ...comic,
                page: { ...comic.page, aspectRatio },
            });
            const result = await h.executor.execute({
                process: "character-emoji",
                version: "v3",
                input: {
                    cast,
                    idea: "两个版本比较身高",
                    ...(mode === "comic" ? { mode } : {}),
                    aspectRatio,
                    background: "transparent",
                },
            });
            expect(result.status).toBe("succeeded");
            const request = h.render.mock.calls[0]?.[0];
            if (!request) throw new Error("没有调用图片渲染");
            const [w, hgt] = request.size.split("x").map(Number);
            const [rw, rh] = aspectRatio.split(":").map(Number);
            expect(w / hgt).toBeCloseTo(rw / rh);
            expect(request.background).toBe("transparent");
            expect(request.prompt).toContain("背景透明");
            expect(request.prompt).not.toContain("绘制一张方形");
        }
    });
    it("模型选错画布时不生图，旧版不能静默丢弃新参数", async () => {
        const h = harness();
        const input = {
            mode: "comic",
            cast,
            idea: "比较身高",
            aspectRatio: "16:9",
            background: "transparent",
        };
        expect(
            (
                await h.executor.execute({
                    process: "character-emoji",
                    version: "v3",
                    input,
                })
            ).status,
        ).toBe("failed");
        expect(h.render).not.toHaveBeenCalled();
        expect(
            (
                await h.executor.execute({
                    process: "character-emoji",
                    version: "v2",
                    input,
                })
            ).status,
        ).toBe("failed");
        expect(
            versionedInputSchema.safeParse({ ...input, aspectRatio: "invalid" })
                .success,
        ).toBe(false);
    });
});
