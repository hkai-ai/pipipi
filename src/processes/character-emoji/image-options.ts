/** 定义 v3 可选画布与背景，未选择时保留原有生成行为。 */
import { z } from "zod";

export const aspectRatios = [
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "9:16",
    "16:9",
    "1:2",
    "2:1",
] as const;
export const imageOptionsShape = {
    aspectRatio: z.enum(aspectRatios).optional(),
    background: z.enum(["transparent", "opaque"]).optional(),
};
export type ImageOptions = {
    aspectRatio?: (typeof aspectRatios)[number];
    background?: "transparent" | "opaque";
};
export const imageSizes = {
    "1:1": "1536x1536",
    "2:3": "1024x1536",
    "3:2": "1536x1024",
    "3:4": "1152x1536",
    "4:3": "1536x1152",
    "9:16": "864x1536",
    "16:9": "1536x864",
    "1:2": "1024x2048",
    "2:1": "2048x1024",
} as const;
export function imageOptionsRule(options: ImageOptions) {
    return [
        options.aspectRatio
            ? `整张图片宽高比固定为${options.aspectRatio}，优先于默认方形；漫画page.aspectRatio必须相同，按此画布自由设计分格，不拉伸人物。`
            : "",
        options.background === "transparent"
            ? "背景透明，输出真实透明PNG，不绘制白底或棋盘格。保留人物、必要道具和文字；漫画保留画格、对白与叙事元素，其余留白透明。"
            : "",
        options.background === "opaque"
            ? "输出不透明背景，场景背景随剧情设计。"
            : "",
    ]
        .filter(Boolean)
        .join("\n");
}
