/** 检查透明成品确实含可见像素和透明像素，失败不触发重新生图。 */
import sharp from "sharp";
import type { ImageBackground } from "../processes/image-background.js";

export async function assertImageBackground(
    bytes: Uint8Array,
    background?: ImageBackground,
): Promise<void> {
    if (background !== "transparent") return;
    const image = sharp(bytes);
    const metadata = await image.metadata();
    if (!metadata.hasAlpha) throw new Error("生成结果缺少透明通道");
    const { channels } = await image.stats();
    const alpha = channels.at(-1);
    if (!alpha || alpha.min === 255 || alpha.max === 0) {
        throw new Error("生成结果没有有效的透明前景");
    }
}
