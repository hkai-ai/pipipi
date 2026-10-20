/** 按角色和题材挑选有界本地素材，并区分本地、联网与原创来源。 */
import { type MemeCard, memeCards } from "./memes.js";
import type { Brief, ComicBrief } from "./schema.js";
import type { MemeResearch } from "./search.js";

export type AdaptationSource = "original" | "local" | "research" | "mixed";

export function selectMemes(brief: Brief | ComicBrief): readonly MemeCard[] {
    const idea = brief.idea.normalize("NFKC").toLowerCase();
    const score = (card: MemeCard) =>
        card.aliases.reduce(
            (sum, alias) =>
                sum + (idea.includes(alias.toLowerCase()) ? 100 : 0),
            0,
        ) +
        card.topics.reduce(
            (sum, topic) => sum + (idea.includes(topic.toLowerCase()) ? 1 : 0),
            0,
        );
    const cast = new Set(brief.cast.map(({ character }) => character));
    const ranked = memeCards
        .filter((card) =>
            card.characters.some((character) => cast.has(character)),
        )
        .map((card) => ({ card, score: score(card) }))
        .sort((a, b) => b.score - a.score);
    const chosen = new Map<string, MemeCard>();
    const add = (card: MemeCard | undefined) => {
        if (card && chosen.size < 6) chosen.set(card.id, card);
    };
    // 明确点名的素材优先，其余先覆盖所选角色，再补相关候选。
    for (const item of ranked.filter((item) => item.score >= 100))
        add(item.card);
    for (const character of cast)
        add(
            ranked.find(({ card }) => card.characters.includes(character))
                ?.card,
        );
    for (const { card } of ranked) add(card);
    const common = memeCards
        .filter((card) => card.characters.length === 0)
        .map((card) => ({ card, score: score(card) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .map(({ card }) => card);
    return [...chosen.values(), ...common];
}

export function memesForAgent(cards: readonly MemeCard[]) {
    return cards.map(({ id, name, summary, scope }) => ({
        id,
        name,
        summary,
        scope,
    }));
}

export function availableMaterialIds(
    local: readonly MemeCard[],
    research: readonly MemeResearch[],
) {
    // 搜索失败仍遵循直接原创策略，不把已有短卡冒充本次检索成果。
    if (research.some((result) => result.status === "failed")) return [];
    return [
        ...new Set([
            ...local.map((card) => card.id),
            ...research.flatMap((result) =>
                result.entries
                    .filter((entry) => entry.kind !== "background")
                    .map((entry) => entry.id),
            ),
        ]),
    ];
}

export function adaptationSource(
    adaptation: { entryIds: readonly string[] } | { entryId: string | null },
    local: readonly MemeCard[],
): AdaptationSource {
    const ids =
        "entryIds" in adaptation
            ? adaptation.entryIds
            : adaptation.entryId === null
              ? []
              : [adaptation.entryId];
    if (ids.length === 0) return "original";
    const localIds = new Set(local.map((card) => card.id));
    const localCount = ids.filter((id) => localIds.has(id)).length;
    return localCount === ids.length
        ? "local"
        : localCount === 0
          ? "research"
          : "mixed";
}
