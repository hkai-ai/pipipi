/** 图片流程的可选背景参数合同，直接传给模型，不改写提示词。 */
import { z } from "zod";

export const imageBackgroundSchema = z
    .enum(["auto", "transparent", "opaque"])
    .describe(
        "可选背景模式：auto（默认）、transparent（透明底，交付前校验同时含可见与透明像素）或 opaque（不透明）；直接传给绘图模型，不改写提示词。",
    );
export type ImageBackground = z.infer<typeof imageBackgroundSchema>;
