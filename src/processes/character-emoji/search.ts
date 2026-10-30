/** 宽容接收搜梗材料、标注来源可信程度，并提供原创兜底结果。 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Brief, ComicBrief } from "./schema.js";

export const researchSchema = z.strictObject({
    entries: z
        .array(
            z.strictObject({
                kind: z.enum([
                    "community_primary",
                    "community_secondary",
                    "background",
                ]),
                summary: z.string(),
                sourceUrl: z.string(),
            }),
        )
        .max(2),
    insufficiency: z.string().max(200),
});
export type ResearchEntry = {
    kind:
        | "community_primary"
        | "community_secondary"
        | "background"
        | "unverified";
    summary: string;
    sourceUrl: string;
    id: string;
    sourceQuote: string;
    verification: "cited" | "unverified";
};

export type MemeResearch = Readonly<{
    status: "usable" | "insufficient" | "unverifiable" | "failed";
    text: string;
    entries: readonly ResearchEntry[];
    sources: readonly Readonly<{ title: string; url: string }>[];
}>;

export type MemeSearch = Readonly<{
    search: (
        input: {
            cast: Brief["cast"] | ComicBrief["cast"];
            idea: string;
            focus?: string;
        },
        options: {
            signal: AbortSignal;
            maxKeywords: number;
            maxOutputTokens: number;
        },
    ) => Promise<MemeResearch>;
}>;

export function originalResearch(): MemeResearch {
    return {
        status: "failed",
        entries: [],
        sources: [],
        text: "本次搜索失败。直接按用户需求原创，不再搜索，不声称采用了网上的梗或真实社区经历。",
    };
}

/** 只向创作会话提供有界摘要与引用片段，完整绑定资料留在请求内。 */
export function researchForAgent(research: MemeResearch) {
    const excerpt = (value: string, limit: number) => {
        const text = value.trim();
        return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
    };
    return {
        status: research.status,
        text: excerpt(research.text, 400),
        entries: research.entries.slice(0, 2).map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            verification: entry.verification,
            summary: excerpt(entry.summary, 800),
            ...(entry.sourceQuote.trim() &&
            entry.sourceQuote.trim() !== entry.summary.trim()
                ? { sourceQuote: excerpt(entry.sourceQuote, 1200) }
                : {}),
        })),
    };
}

function sourceUrl(value: unknown) {
    if (typeof value !== "string" || value.length > 2048) return "";
    try {
        const url = new URL(value);
        return ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password
            ? url.href
            : "";
    } catch {
        return "";
    }
}

// 每条独立接收；缺引用或格式不齐只降低可信程度，不清空其余素材。
export function bindResearch(
    raw: unknown,
    sources: readonly { title: string; url: string; excerpt?: string }[],
): MemeResearch {
    if (
        !raw ||
        typeof raw !== "object" ||
        !Array.isArray((raw as { entries?: unknown }).entries)
    )
        throw new Error("搜索材料没有条目列表");
    const parsed = raw as { entries: unknown[]; insufficiency?: unknown };
    const entries: ResearchEntry[] = parsed.entries
        .slice(0, 10)
        .flatMap((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value))
                return [];
            const entry = value as Record<string, unknown>;
            // 兼容旧格式，正文统一交给 Agent 判断，不要求模型拆出固定的行为字段。
            const summary = [
                entry.summary,
                entry.behavior,
                entry.expectation,
                entry.contrast,
            ]
                .filter(
                    (text): text is string =>
                        typeof text === "string" && !!text.trim(),
                )
                .join("\n")
                .slice(0, 4000);
            if (!summary) return [];
            const url = sourceUrl(entry.sourceUrl);
            const source = sources.find(
                (source) => url && sourceUrl(source.url) === url,
            );
            const kind = [
                "community_primary",
                "community_secondary",
                "background",
            ].includes(String(entry.kind))
                ? (entry.kind as ResearchEntry["kind"])
                : "unverified";
            const item = {
                kind,
                summary,
                sourceUrl: url,
                sourceQuote: source?.excerpt?.slice(0, 16000) ?? "",
                verification: source?.excerpt?.trim()
                    ? ("cited" as const)
                    : ("unverified" as const),
            };
            return [
                {
                    ...item,
                    id: createHash("sha256")
                        .update(JSON.stringify(item))
                        .digest("hex")
                        .slice(0, 16),
                },
            ];
        })
        .slice(0, 2);
    return {
        status: entries.some(
            (entry) =>
                entry.kind !== "background" && entry.verification === "cited",
        )
            ? "usable"
            : entries.some((entry) => entry.kind !== "background")
              ? "unverifiable"
              : "insufficient",
        text: [
            typeof parsed.insufficiency === "string"
                ? parsed.insufficiency.slice(0, 1000)
                : "",
            ...(entries.some((entry) => entry.verification === "unverified")
                ? [
                      "未核验材料可作创作参考，但不能声称是已证实的社区经历；不适合主题时原创。",
                  ]
                : []),
        ]
            .filter(Boolean)
            .join("\n"),
        sources: sources.map(({ title, url }) => ({ title, url })),
        entries,
    };
}
