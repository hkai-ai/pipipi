/** 统一印花文字比较中的排版等价字符。 */

// 重音符号须在 NFKC 将其展开前转成撇号。
export const normalizePrintText = (text: string) =>
    text
        .replace(/´/gu, "'")
        .normalize("NFKC")
        .replace(/[’‘‛`]/gu, "'")
        .replace(/[“”]/gu, '"')
        .replace(/[‐‑‒–—]/gu, "-")
        .replace(/\s+/gu, "")
        .toLowerCase();
