import { describe, expect, it } from "vitest";
import { versionedInputSchema } from "../src/processes/character-emoji/cast.js";
import {
    characters,
    hasAppearance,
    imageUrl,
} from "../src/processes/character-emoji/catalog.js";
import { characterPersonas } from "../src/processes/character-emoji/character-personas.js";
import {
    memesForAgent,
    selectMemes,
} from "../src/processes/character-emoji/materials.js";
import { plannerInput } from "../src/processes/character-emoji/prompt.js";
import { sceneImagePrompt } from "../src/processes/character-emoji/scene-prompt.js";
import { briefSchema } from "../src/processes/character-emoji/schema.js";

const brief = {
    cast: [{ character: "Doubao" as const, appearance: "Chibi" as const }],
    idea: "外放社死",
};
describe("豆包原版 Q 版", () => {
    it("v2 与 v3 接收 Q 版，拒绝没有参考图的少女版", () => {
        expect(characters.some((item) => item.id === "Doubao")).toBe(true);
        expect(hasAppearance("Doubao", "Chibi")).toBe(true);
        expect(hasAppearance("Doubao", "Girl")).toBe(false);
        expect(imageUrl("Doubao", "Chibi")).toContain(
            "chibi-5e7e8f7823faaa50.png",
        );
        expect(() => imageUrl("Doubao", "Girl")).toThrow();
        for (const schema of [briefSchema, versionedInputSchema]) {
            expect(schema.safeParse(brief).success).toBe(true);
            expect(
                schema.safeParse({
                    ...brief,
                    cast: [{ character: "Doubao", appearance: "Girl" }],
                }).success,
            ).toBe(false);
        }
    });
    it("构思收到豆包背景，素材按角色选取且不把来源链接传给模型", () => {
        const cards = selectMemes(brief);
        expect(cards[0]?.id).toBe("local:doubao-speaker");
        expect(
            cards.filter((card) => card.characters.includes("Doubao")),
        ).toHaveLength(3);
        expect(memesForAgent(cards).every((card) => !("sources" in card))).toBe(
            true,
        );
        expect(plannerInput(brief)).toContain(characterPersonas.Doubao);
        const mixed = selectMemes({
            ...brief,
            cast: [...brief.cast, { character: "Claude", appearance: "Girl" }],
        });
        expect(mixed.some((card) => card.characters.includes("Claude"))).toBe(
            true,
        );
        expect(mixed.some((card) => card.characters.includes("Doubao"))).toBe(
            true,
        );
    });
    it("生图绑定豆包原版 3D 外观", () => {
        const prompt = sceneImagePrompt(brief, {
            scene: "豆包伸手按静音，扬声器仍亮着。",
            caption: "小声点！",
            propMarks: [],
            actors: [{ character: "Doubao", identityMark: null }],
        });
        expect(prompt).toContain("Doubao:Chibi");
        expect(prompt).toContain("3D卡通质感");
        expect(prompt).toContain("不因贴纸或漫画载体改成日系女仆角色");
    });
});
