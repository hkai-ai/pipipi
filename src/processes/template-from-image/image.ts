/** 将受控公网参考图解码为有界视觉附件，只在本次执行内保留图片字节。 */
import sharp from "sharp";
import { downloadSourcePhoto } from "../../business-api/source-photo.js";

export type TemplateImage = Readonly<{
    data: string;
    mimeType: "image/png";
    width: number;
    height: number;
}>;

export type TemplateImageLoader = (
    imageUrl: string,
    signal: AbortSignal,
) => Promise<TemplateImage>;

export async function decodeTemplateImage(
    bytes: Buffer,
): Promise<TemplateImage> {
    const source = sharp(bytes, {
        limitInputPixels: 40_000_000,
        failOn: "warning",
    });
    const metadata = await source.metadata();
    if (
        !metadata.format ||
        !["png", "jpeg", "webp"].includes(metadata.format) ||
        (metadata.pages ?? 1) !== 1
    ) {
        throw new Error("参考图必须是静态 PNG、JPEG 或 WebP");
    }
    const oriented = metadata.autoOrient;
    if (
        !oriented.width ||
        !oriented.height ||
        oriented.width < 64 ||
        oriented.height < 64
    ) {
        throw new Error("参考图宽高至少为 64 像素");
    }
    const normalized = await source
        .rotate()
        .resize({
            width: 1_600,
            height: 1_600,
            fit: "inside",
            withoutEnlargement: true,
        })
        .png()
        .toBuffer();
    return Object.freeze({
        data: normalized.toString("base64"),
        mimeType: "image/png",
        width: oriented.width,
        height: oriented.height,
    });
}

export const loadTemplateImage: TemplateImageLoader = async (url, signal) => {
    signal.throwIfAborted();
    const bytes = await downloadSourcePhoto(url, signal);
    signal.throwIfAborted();
    const image = await decodeTemplateImage(bytes);
    signal.throwIfAborted();
    return image;
};

const imageSizes = [
    "1024x1024",
    "1152x896",
    "896x1152",
    "768x1344",
    "1344x768",
] as const;

export function templateImageSize(
    image: Pick<TemplateImage, "width" | "height">,
): string {
    const difference = (size: string) => {
        const [width, height] = size.split("x").map(Number);
        return Math.abs(
            Math.log(image.width / image.height / (width / height)),
        );
    };
    return imageSizes.reduce((best, size) =>
        difference(size) < difference(best) ? size : best,
    );
}
