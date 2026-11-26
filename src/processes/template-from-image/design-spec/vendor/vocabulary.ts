/** 从 Memebuy 同步生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
// 编译器检查用的词表与枚举映射；词表与 Skill compile.py 保持一致，改动须两边同步并重生成金标。
// P1/P2 的正交轴、边框库、让位句、实边句、覆盖字段与编译修复已同步到 Skill compile.py。
import type { DesignSpecBorderId } from "./design-spec-schema.js";

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

/** 无容器的满版承重画面收尾句：保留完整背景与构图，不编造外边框或贴纸轮廓。 */
export const FULL_BLEED_WHOLE_SENTENCE =
    "这是一幅满版完整画面：画面与背景铺满整张画布，保留原图的版面与构图留白，不额外添加外边框、贴片包边或贴纸白边轮廓。";

/** 不得混入可执行画面描述的审阅备注或草稿词（会直接进生图提示词干扰模型）。 */
export const DRAFT_META_WORDS = [
    "原图未见",
    "原图未显示",
    "候选新增",
    "需人工确认",
    "待人工确认",
    "须人工叠图核对",
    "待人工叠图核对",
    "需核对内容框",
    "边框需人工确认",
] as const;

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

/** 边框库措辞：固定一层；有颜色角色时引用 {色:角色名}。措辞正本：v4 Spec 第 11 节、RULES.md 第 3 节。 */
export const BORDER_LIBRARY: Record<
    DesignSpecBorderId,
    { label: string; describe: (color: string | null) => string }
> = {
    rounded_line: {
        label: "圆角细边",
        describe: (color) =>
            `圆角矩形卡片，单层细实线包边${color ? `，线色为 ${color}` : ""}`,
    },
    polaroid: {
        label: "拍立得",
        describe: (color) =>
            color
                ? `拍立得相纸，四周窄边、下边略宽，边的颜色为 ${color}，无其他描边`
                : "拍立得相纸，四周窄白边、下边略宽，无其他描边",
    },
    torn_paper: {
        label: "撕纸",
        describe: (color) =>
            `手撕纸边，边缘不规则毛糙，单层${color ? `，纸边颜色为 ${color}` : ""}`,
    },
    stamp: {
        label: "邮票齿边",
        describe: (color) =>
            `邮票齿孔边，齿孔均匀，单层${color ? `，边的颜色为 ${color}` : ""}`,
    },
    arch: {
        label: "拱窗",
        describe: (color) =>
            `上沿为半圆拱形、下沿平直的窗形，单层细边${color ? `，线色为 ${color}` : ""}`,
    },
};

/** 边框库外轮廓段的固定结尾：只有一层。 */
export const SINGLE_BORDER_RULE = "只有一层边框，不加内外描边。";

/** 有「收形」元素时补的一句；作者的描述里已写明实心的不重复补。 */
export const SOLID_EDGE_RULE =
    "外轮廓与收边都是实心的清楚边缘，不渐隐、不半透明。";

/** 主体被替换时，戴在主体身上的配饰追加的让位句。 */
export const WORN_ON_SUBJECT_YIELD_SENTENCE =
    "戴在主体身上；主体的标志性特征（如长耳朵、角、特殊发型）从配饰下面或两侧伸出来，保持可见，配饰随之调整。";

/** 附图说明里“照原图的画法和版面”在改画法时的替换措辞（techniqueOverride）。 */
export const TECHNIQUE_OVERRIDDEN_REFERENCE_SCOPE =
    "只取其中的内容与版面，画法按下面的描述来画";
