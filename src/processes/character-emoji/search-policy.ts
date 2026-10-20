/** 根据创意中的明确检索或时效要求，保守决定是否开放搜梗工具。 */
export function allowsMemeSearch(idea: string): boolean {
    // 台词和引用里的搜索用语不是对服务端的检索要求。
    const request = idea.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g, "");
    const clauses = request
        .split(/[，,。；;！!？?\n]/)
        .map((part) => part.trim());
    const refusal = /(?:不要|不用|无需|禁止|不必|别|不允许|不需要|不想)/;
    if (
        clauses.some(
            (part) =>
                /(?:不要|不用|无需|禁止|不必|别|不允许|不需要|不想).{0,8}(?:联网|上网|搜索|检索|搜梗|查资料)/.test(
                    part,
                ) ||
                /\b(?:do not|don't|never|without|no)\s+(?:web\s+search|search(?:ing)?|brows(?:e|ing))/i.test(
                    part,
                ),
        )
    )
        return false;
    return clauses.some(
        (part) =>
            !refusal.test(part) &&
            (/^(?:请|帮我|麻烦|先|需要|要求|务必|必须|记得|能否|可以|再|去|你|给我|\s)*(?:联网|上网|搜梗|查资料|搜索|检索|搜一下|查一下|查找|核实|核验|查证)/.test(
                part,
            ) ||
                /(?:最新|近期|最近|本周|今天|当前|实时).{0,12}(?:新闻|热点|热搜|热梗|公告|版本发布|政策|价格|事件|动态)/.test(
                    part,
                ) ||
                /^(?:please\s+)?(?:search\s+(?:the\s+web|online|for\s+memes)|browse\s+the\s+web|look\s+up)\b/i.test(
                    part,
                )),
    );
}
