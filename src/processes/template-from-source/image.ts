/** 为同一原图提供总览和固定局部细节，只辅助观察，不改变生产源图。 */
import sharp from "sharp";
import type { TemplateImage } from "../template-from-image/image.js";

export async function prepareStrategyImages(
    image: TemplateImage,
    signal: AbortSignal,
) {
    signal.throwIfAborted();
    const bytes = Buffer.from(image.data, "base64");
    const { width, height } = await sharp(bytes, {
        limitInputPixels: 1600 * 1600,
    }).metadata();
    if (!width || !height) throw new Error("无法读取原图尺寸");
    const images = [{ data: image.data, mimeType: image.mimeType }];
    const descriptions = [
        "附件1是唯一原图总览，整体布局、主体数量及空间关系以它为准。",
    ];
    // 小图不制造更多模糊裁片；尺寸取解码后的 PNG，不使用原文件的元数据尺寸。
    if (Math.min(width, height) >= 512) {
        const cropWidth = Math.ceil(width / 2);
        const cropHeight = Math.ceil(height / 2);
        const positions = [
            [0.5, 0.5, "中央"],
            [0, 0, "左上"],
            [1, 0, "右上"],
            [0, 1, "左下"],
            [1, 1, "右下"],
        ] as const;
        for (const [x, y, name] of positions) {
            signal.throwIfAborted();
            const left = Math.floor((width - cropWidth) * x);
            const top = Math.floor((height - cropHeight) * y);
            const data = await sharp(bytes)
                .extract({ left, top, width: cropWidth, height: cropHeight })
                .resize({ width: 1024, height: 1024, fit: "inside" })
                .png()
                .toBuffer();
            signal.throwIfAborted();
            images.push({
                data: data.toString("base64"),
                mimeType: "image/png",
            });
            descriptions.push(
                `附件${images.length}是原图${name}区域等比例细节，原图像素范围 x=${left}..${left + cropWidth}，y=${top}..${top + cropHeight}。`,
            );
        }
        descriptions.push(
            "所有局部图都来自同一原图，不是新增主体、重复实例或另一张设计。裁片边界不是原图边界；只辅助读取原文、轮廓、基线及媒介细节，不改变原图证据。无法辨认的细节明确记录不确定，不能补造。",
        );
    }
    signal.throwIfAborted();
    return { images, context: descriptions.join("\n") };
}
