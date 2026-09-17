/** 为同一原图提供总览和受控细节，完整内容观察保留跨区域关系。 */
import sharp from "sharp";
import { measureContentContours } from "./contours.js";
import type { TemplateImage } from "./image.js";

export async function prepareTemplateImageViews(
    image: TemplateImage,
    signal: AbortSignal,
    detail: "regions" | "content" = "regions",
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
    if (detail === "content") {
        const contours = await measureContentContours(bytes, signal);
        if (contours) {
            descriptions.push(
                "辅助像素测量（不是排版结论）：pixelContours 为近单色背景下可分离内容带的分段前景上下边缘，y 向下增大；是墨迹外缘，不是字体基线。请对照图像核对整组形态，区分整体趋势与局部字形，不必猜测制作方式。低对比细节可能未被分离，不据此删除图中内容。",
            );
        }
        const { data, info } = await sharp(bytes)
            .trim({ threshold: 5 })
            .png()
            .toBuffer({ resolveWithObject: true });
        signal.throwIfAborted();
        if (
            (info.width !== width || info.height !== height) &&
            typeof info.trimOffsetLeft === "number" &&
            typeof info.trimOffsetTop === "number"
        ) {
            images.push({
                data: data.toString("base64"),
                mimeType: "image/png",
            });
            descriptions.push(
                `附件2是去除近似背景边缘后的完整内容观察图，保持内容之间的相对位置，不分割整行文字或组件组；原图像素范围 x=${-info.trimOffsetLeft}..${-info.trimOffsetLeft + info.width}，y=${-info.trimOffsetTop}..${-info.trimOffsetTop + info.height}。边缘检测可能忽略淡色细节，原图仍是完整依据；裁片外框不是原设计边界，不能据此改变留白或构图。`,
            );
        }
        return { images, context: descriptions.join("\n"), contours };
    }
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
    return { images, context: descriptions.join("\n"), contours: null };
}
