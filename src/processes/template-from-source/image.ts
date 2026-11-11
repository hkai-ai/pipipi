/** 复用模板图片的有界观察附件，保持既有策略 Agent 的调用接口。 */

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
    return views;
}
