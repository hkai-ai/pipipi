/** 图片流程的可选背景参数合同，直接传给模型，不改写提示词。 */
import { z } from "zod";

export const imageBackgroundSchema = z.enum(["auto", "transparent", "opaque"]);
export type ImageBackground = z.infer<typeof imageBackgroundSchema>;
