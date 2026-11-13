/** 从固定 Memebuy 来源生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
// 编译器检查用的词表与枚举映射；词表与 Skill compile.py 保持一致，改动须两边同步并重生成金标。

export const STYLE_WORDS = [
    "Q 版",
    "Q版",
    "满版风格",
    "糖果",
    "小幽默",
    "萌系",
];

export const GLOW_WORDS = [
    "光晕",
    "发光",
    "辉光",
    "光雾",
    "烟雾",
    "雾气",
    "薄雾",
    "朦胧",
    "柔焦",
    "虚化",
    "景深",
    "半透明",
    "透明感",
    "透光",
    "光束",
    "霓虹光",
    "淡出",
    "渐渐透明",
    "逐渐透明",
    "渐隐成透明",
    "柔光",
    "投影",
];

export const CROWD_WORDS = [
    "撑满画面",
    "占满画面",
    "铺满画布",
    "撑满画布",
    "顶到画布边",
    "贴着画布边",
];

export const SOLID_RULE =
    "每个形状都是实心的，边缘清楚；明暗和光感用颜色深浅画在形状内部。";

/** 矩形贴片（设计贴片）的整体收尾句：透明画布 + 不透明的设计贴片，逐字对应 compile.py 的 PATCH_WHOLE。 */
export const PATCH_WHOLE_SENTENCE =
    "这是一张设计贴片：画布是透明底，画面是一块不透明的实心贴片，边框按“外轮廓”写的样子画出，完整地落在画布内；贴片以外的画布完全透明，什么都不画（没有底色、阴影、渐变）；版面里压在边框上、伸出边框的元素画在边框之上，可以越出贴片。";

/** 颜色占位 {色:角色名}；每次使用都新建，避免 g 标志的 lastIndex 串扰。 */
export function colorPlaceholderPattern(): RegExp {
    return /\{色:([^{}]+)\}/gu;
}

/** 印花形态的中文名（compile.py 的 印花形态）。 */
export const PRINT_FORM_LABEL = {
    standalone: "独立图形",
    rect_patch: "矩形贴片",
    bleed_crop: "出血裁切",
} as const;
