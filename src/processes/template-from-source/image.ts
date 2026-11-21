/** 复用模板图片的有界观察附件，保持既有策略 Agent 的调用接口。 */

import sharp from "sharp";
import type { TemplateImage } from "../template-from-image/image.js";
import { prepareTemplateImageViews } from "../template-from-image/image-views.js";

export async function prepareStrategyImages(
    image: TemplateImage,
    signal: AbortSignal,
) {
    const views = await prepareTemplateImageViews(image, signal);
    if (image.hasTransparency) {
        views.context +=
            "\n原件包含透明像素。除非制作要求明确更换背景，保留原图透明区域和主体内部的颜色、文字与阴影。预览透出的底色不能写入画布、冻结项、配色或稳定锚点。";
    }
    // 按 Base64 传输大小计量，为 JSON Schema、Skill 和请求封装留出空间。
    const budget = 768 * 1024;
    if (
        views.images.reduce((size, view) => size + view.data.length, 0) <=
        budget
    )
        return views;
    for (let maxEdge = 1024; ; maxEdge = Math.ceil(maxEdge / 2)) {
        const images = [];
        for (const view of views.images) {
            signal.throwIfAborted();
            const data = await sharp(Buffer.from(view.data, "base64"))
                .resize({
                    width: maxEdge,
                    height: maxEdge,
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .webp({ quality: 80 })
                .toBuffer();
            images.push({
                data: data.toString("base64"),
                mimeType: "image/webp" as const,
            });
        }
        if (images.reduce((size, view) => size + view.data.length, 0) <= budget)
            return { ...views, images };
    }
}
