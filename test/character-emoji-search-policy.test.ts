/** 验证普通创作关闭搜索，明确检索与时效要求才开放工具。 */
import { describe, expect, it } from "vitest";
import { allowsMemeSearch } from "../src/processes/character-emoji/search-policy.js";

describe("表情包搜索权限", () => {
    it.each([
        "ChatGPT和Grok一起修摇晃的桌子，做成单张表情包。",
        "今天Qwen、Gemini和Kimi去露营，抢救晚饭，画成三格漫画。",
        "Claude和DeepSeek做生日蛋糕，越帮越忙。",
        "没有合适的本地梗，帮我原创一个。",
        "角色举牌说“请联网搜索最新新闻”，画成表情包。",
        "不要联网搜索，用最新热梗这个词当台词。",
        "请搜索梗，但不要联网。",
        "不用最新新闻，直接原创。",
        "Do not search online. Draw a camping comic.",
    ])("关闭：%s", (idea) => {
        expect(allowsMemeSearch(idea)).toBe(false);
    });

    it.each([
        "请帮我联网搜梗，再改成漫画。",
        "先核实这个梗的出处，再创作。",
        "根据Claude最新新闻创作表情包。",
        "结合近期热梗画漫画。",
        "Please search the web for memes.",
    ])("开放：%s", (idea) => {
        expect(allowsMemeSearch(idea)).toBe(true);
    });
});
