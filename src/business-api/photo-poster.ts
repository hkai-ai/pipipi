/** 照片风格图片编辑、旅行档案文字合成与成品存储。 */
import sharp from "sharp";
import type { ImageBackground } from "../processes/image-background.js";
import type { PhotoPosterRenderInput } from "../processes/photo-poster/capability.js";

/** 统一解码为显示方向的 RGB 原图，限制解码像素和成品尺寸。 */
export async function decodeSourcePhoto(bytes: Buffer) {
    const metadata = await sharp(bytes, {
        limitInputPixels: 16_777_216,
    }).metadata();
    if (
        !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
        (metadata.pages ?? 1) !== 1
    ) {
        throw new Error("参考图必须是静态 PNG、JPEG 或 WebP");
    }
    const original = await sharp(bytes, { limitInputPixels: 16_777_216 })
        .rotate()
        .flatten({ background: "white" })
        .toColourspace("srgb")
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    if (
        original.info.width < 320 ||
        original.info.height < 240 ||
        original.info.width > 4_096 ||
        original.info.height > 4_096
    ) {
        throw new Error("抽象摄影原图尺寸超出支持范围");
    }
    return original;
}

/** 只在独立抽象作品上绘制档案字样，不拼接原图或改变成品尺寸。 */
export async function finalizeTravelPhoto(
    panel: Buffer,
    archive: NonNullable<PhotoPosterRenderInput["archive"]>,
    background?: ImageBackground,
): Promise<Buffer> {
    const { width, height } = await sharp(panel).metadata();
    if (width !== 1_200 || height !== 1_600)
        throw new Error("抽象成品尺寸不正确");
    const fontSize = Math.round(width * 0.013);
    const margin = Math.round(width * 0.05);
    const date = new Date(`${archive.date}T00:00:00Z`)
        .toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            timeZone: "UTC",
        })
        .toUpperCase();
    // 档案字段由严格 Schema 限定为英文字母、数字和空格。
    const lettering = Buffer.from(
        `<svg width="${width}" height="${height}"><g font-family="monospace" font-size="${fontSize}" fill="#888888"><text x="${width - margin}" y="${margin}" text-anchor="end">NO. ${String(archive.number).padStart(3, "0")}</text><text x="${margin}" y="${height - margin - fontSize * 1.6}">${date}</text><text x="${margin}" y="${height - margin}">${archive.phrase}</text></g></svg>`,
    );
    const result = sharp(panel).composite([
        { input: lettering, top: 0, left: 0 },
    ]);
    if (background !== "transparent") result.removeAlpha();
    return result.png().toBuffer();
}
