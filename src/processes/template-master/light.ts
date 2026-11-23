/** 轻档确定性加工：四边连通色键去衬底、原样转 PNG，不调用任何模型。 */
import sharp from "sharp";
import {
    COLOR_KEY_EDGE_UNIFORM_MIN,
    COLOR_KEY_FRINGE_TOLERANCE,
    COLOR_KEY_TOLERANCE,
    MAX_SIDE,
} from "./thresholds.js";

export type Rgba = Readonly<{ data: Buffer; width: number; height: number }>;
export type PrintForm = "standalone" | "rect_patch" | "bleed_crop";

/** 解码为 RGBA 原始像素，按 EXIF 摆正，长边超过 maxSide 时等比缩小。 */
export async function decodeRgba(
    bytes: Buffer,
    maxSide: number = MAX_SIDE,
): Promise<Rgba> {
    const { data, info } = await sharp(bytes, {
        limitInputPixels: 40_000_000,
        failOn: "warning",
    })
        .rotate()
        .resize({
            width: maxSide,
            height: maxSide,
            fit: "inside",
            withoutEnlargement: true,
        })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}

export function encodePng(image: Rgba): Promise<Buffer> {
    return sharp(image.data, {
        raw: { width: image.width, height: image.height, channels: 4 },
    })
        .png()
        .toBuffer();
}

export function hasTransparentPixel(image: Rgba): boolean {
    for (let i = 3; i < image.data.length; i += 4)
        if ((image.data[i] as number) < 255) return true;
    return false;
}

const distance = (data: Buffer, offset: number, color: readonly number[]) =>
    Math.hypot(
        (data[offset] as number) - (color[0] as number),
        (data[offset + 1] as number) - (color[1] as number),
        (data[offset + 2] as number) - (color[2] as number),
    );

function borderOffsets(width: number, height: number): number[] {
    const offsets: number[] = [];
    for (let x = 0; x < width; x++) offsets.push(x, (height - 1) * width + x);
    for (let y = 1; y < height - 1; y++)
        offsets.push(y * width, y * width + width - 1);
    return offsets;
}

/** 边缘主色：最外一圈像素按 5 位量化取众数桶，再取该桶内像素的均值。 */
export function edgeColor(image: Rgba): {
    color: [number, number, number];
    uniformShare: number;
} {
    const { data, width, height } = image;
    const buckets = new Map<number, number>();
    const border = borderOffsets(width, height);
    for (const pixel of border) {
        const o = pixel * 4;
        const key =
            ((data[o] as number) >> 3) * 1024 +
            ((data[o + 1] as number) >> 3) * 32 +
            ((data[o + 2] as number) >> 3);
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    let best = 0;
    let bestCount = -1;
    for (const [key, count] of buckets)
        if (count > bestCount) {
            best = key;
            bestCount = count;
        }
    const sum = [0, 0, 0];
    let members = 0;
    for (const pixel of border) {
        const o = pixel * 4;
        const key =
            ((data[o] as number) >> 3) * 1024 +
            ((data[o + 1] as number) >> 3) * 32 +
            ((data[o + 2] as number) >> 3);
        if (key !== best) continue;
        sum[0] += data[o] as number;
        sum[1] += data[o + 1] as number;
        sum[2] += data[o + 2] as number;
        members++;
    }
    const color = sum.map((value) => Math.round(value / members)) as [
        number,
        number,
        number,
    ];
    const near = border.filter(
        (pixel) => distance(data, pixel * 4, color) <= COLOR_KEY_TOLERANCE,
    ).length;
    return { color, uniformShare: near / border.length };
}

/**
 * 四边连通色键：从画布四边出发，沿四邻接扩散，去掉与边缘相连且接近边缘主色的像素；
 * 被框线围住、不与边缘相连的同色区保留。底不均匀（照片、渐变）时不处理，保留原图像素。
 * 返回新像素与是否改动；不改动输入。
 */
export function keyOutEdgeBackground(image: Rgba): {
    image: Rgba;
    removed: number;
} {
    const { width, height } = image;
    const { color, uniformShare } = edgeColor(image);
    if (uniformShare < COLOR_KEY_EDGE_UNIFORM_MIN) return { image, removed: 0 };
    const data = Buffer.from(image.data);
    const total = width * height;
    const removed = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;
    const visit = (pixel: number, tolerance: number) => {
        if (removed[pixel] || distance(data, pixel * 4, color) > tolerance)
            return;
        removed[pixel] = 1;
        queue[tail++] = pixel;
    };
    for (const pixel of borderOffsets(width, height))
        visit(pixel, COLOR_KEY_TOLERANCE);
    while (head < tail) {
        const pixel = queue[head++] as number;
        const x = pixel % width;
        if (x > 0) visit(pixel - 1, COLOR_KEY_TOLERANCE);
        if (x < width - 1) visit(pixel + 1, COLOR_KEY_TOLERANCE);
        if (pixel >= width) visit(pixel - width, COLOR_KEY_TOLERANCE);
        if (pixel < total - width) visit(pixel + width, COLOR_KEY_TOLERANCE);
    }
    // 只做一轮：贴着已去除区域的抗锯齿带用更宽容差去掉，避免留下一圈底色描边。
    const fringe: number[] = [];
    for (let pixel = 0; pixel < total; pixel++) {
        if (removed[pixel]) continue;
        const x = pixel % width;
        const touches =
            (x > 0 && removed[pixel - 1]) ||
            (x < width - 1 && removed[pixel + 1]) ||
            (pixel >= width && removed[pixel - width]) ||
            (pixel < total - width && removed[pixel + width]);
        if (
            touches &&
            distance(data, pixel * 4, color) <= COLOR_KEY_FRINGE_TOLERANCE
        )
            fringe.push(pixel);
    }
    for (const pixel of fringe) removed[pixel] = 1;
    let count = 0;
    for (let pixel = 0; pixel < total; pixel++)
        if (removed[pixel]) {
            data[pixel * 4 + 3] = 0;
            count++;
        }
    return { image: { data, width, height }, removed: count };
}

/** 轻档成品：独立图形且原图无透明时做色键，其余原样转 PNG。记录是否尝试去底，供校验失败时恢复原图。 */
export async function renderLightMaster(source: Buffer, form: PrintForm) {
    const image = await decodeRgba(source);
    if (form !== "standalone" || hasTransparentPixel(image))
        return { png: await encodePng(image), keyAttempted: false };
    return {
        png: await encodePng(keyOutEdgeBackground(image).image),
        keyAttempted: true,
    };
}
