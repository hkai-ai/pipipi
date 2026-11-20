/** 解码并校验做同款输入图与生成图，生成受控编辑 PNG 与 VLM 观察 WebP。 */
import sharp from "sharp";

export const EDIT_REFERENCE_MAX_SIDE = 2_048;
export const VLM_VIEW_MAX_BYTES = 112 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_GENERATED_IMAGE_BYTES = 20_000_000;

export type VlmImageView = Readonly<{
    data: string;
    mimeType: "image/webp";
}>;

export type DecodedRemixImage = Readonly<{
    editPng: Buffer;
    width: number;
    height: number;
    view: VlmImageView;
}>;

export async function encodeVlmView(bytes: Buffer): Promise<VlmImageView> {
    for (let side = 1_280; side >= 100; side = Math.floor(side * 0.75)) {
        const encoded = await sharp(bytes, {
            limitInputPixels: MAX_IMAGE_PIXELS,
        })
            .rotate()
            .resize({
                width: side,
                height: side,
                fit: "inside",
                withoutEnlargement: true,
            })
            .webp({ quality: 82, alphaQuality: 90 })
            .toBuffer();
        if (encoded.length <= VLM_VIEW_MAX_BYTES) {
            return {
                data: encoded.toString("base64"),
                mimeType: "image/webp",
            };
        }
    }
    throw new Error("观察图编码超出字节预算");
}

export async function decodeRemixSourceImage(
    bytes: Buffer,
): Promise<DecodedRemixImage> {
    const source = sharp(bytes, {
        limitInputPixels: MAX_IMAGE_PIXELS,
        failOn: "warning",
    });
    const metadata = await source.metadata();
    if (
        !metadata.format ||
        !["png", "jpeg", "webp"].includes(metadata.format) ||
        (metadata.pages ?? 1) !== 1
    ) {
        throw new Error("输入图必须是静态 PNG、JPEG 或 WebP");
    }
    const oriented = metadata.autoOrient;
    const width = oriented.width ?? metadata.width;
    const height = oriented.height ?? metadata.height;
    if (!width || !height || width < 64 || height < 64) {
        throw new Error("输入图宽高至少为 64 像素");
    }
    const editPng = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
        .rotate()
        .resize({
            width: EDIT_REFERENCE_MAX_SIDE,
            height: EDIT_REFERENCE_MAX_SIDE,
            fit: "inside",
            withoutEnlargement: true,
        })
        .png()
        .toBuffer();
    const view = await encodeVlmView(bytes);
    return Object.freeze({
        editPng,
        width,
        height,
        view,
    });
}

export async function verifyGeneratedPng(
    bytes: Buffer,
): Promise<Readonly<{ width: number; height: number; view: VlmImageView }>> {
    if (bytes.length === 0 || bytes.length > MAX_GENERATED_IMAGE_BYTES) {
        throw new Error("生成图片大小超出允许范围");
    }
    const source = sharp(bytes, {
        limitInputPixels: MAX_IMAGE_PIXELS,
        failOn: "warning",
    });
    const metadata = await source.metadata();
    if (
        metadata.format !== "png" ||
        (metadata.pages ?? 1) !== 1 ||
        !metadata.width ||
        !metadata.height ||
        metadata.width < 64 ||
        metadata.height < 64 ||
        metadata.width > 4_096 ||
        metadata.height > 4_096
    ) {
        throw new Error("生成图片必须是 64-4096 像素的静态 PNG");
    }
    const view = await encodeVlmView(bytes);
    return Object.freeze({
        width: metadata.width,
        height: metadata.height,
        view,
    });
}
