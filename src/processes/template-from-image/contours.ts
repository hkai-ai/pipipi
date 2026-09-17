/** 为单一背景上的可分离内容带提供像素轮廓测量，不推断文字、基线或形状。 */
import sharp from "sharp";

export async function measureContentContours(
    bytes: Buffer,
    signal: AbortSignal,
) {
    signal.throwIfAborted();
    const { data, info } = await sharp(bytes, {
        limitInputPixels: 1600 * 1600,
    })
        .flatten({ background: "white" })
        .toColourspace("srgb")
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    signal.throwIfAborted();
    const { width, height, channels } = info;
    const pixel = (x: number, y: number) => (y * width + x) * channels;
    const edge: number[] = [];
    for (let i = 0; i < 64; i++) {
        const x = Math.floor(((width - 1) * i) / 63);
        const y = Math.floor(((height - 1) * i) / 63);
        edge.push(
            pixel(x, 0),
            pixel(x, height - 1),
            pixel(0, y),
            pixel(width - 1, y),
        );
    }
    const background = [0, 1, 2].map(
        (channel) =>
            edge
                .map((index) => data[index + channel])
                .sort((a, b) => a - b)[128],
    );
    const distance = (index: number) =>
        Math.max(
            ...background.map((value, channel) =>
                Math.abs(data[index + channel] - value),
            ),
        );
    // 边缘背景不一致时不提供测量，避免把照片、纹理或画框误当作纸面。
    if (
        edge.filter((index) => distance(index) <= 16).length <
        edge.length * 0.98
    )
        return null;
    const mask = new Uint8Array(width * height);
    const rows = new Uint32Array(height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (distance(pixel(x, y)) > 40) {
                mask[y * width + x] = 1;
                rows[y]++;
            }
        }
    }
    const ranges: { top: number; bottom: number }[] = [];
    let start: number | null = null;
    for (let y = 0; y <= height; y++) {
        if (y < height && rows[y] >= 3) start ??= y;
        else if (start !== null) {
            if (y - start >= 8) ranges.push({ top: start, bottom: y - 1 });
            start = null;
        }
    }
    if (ranges.length > 8) return null;
    const bands = ranges.flatMap(({ top, bottom }) => {
        let left = width;
        let right = -1;
        for (let y = top; y <= bottom; y++) {
            for (let x = 0; x < width; x++) {
                if (mask[y * width + x]) {
                    left = Math.min(left, x);
                    right = Math.max(right, x);
                }
            }
        }
        const span = right - left + 1;
        if (span < 48 || span < 2 * (bottom - top + 1)) return [];
        const samples = Array.from({ length: 12 }, (_, i) => {
            const x0 = left + Math.floor((span * i) / 12);
            const x1 = left + Math.floor((span * (i + 1)) / 12) - 1;
            let y0 = height;
            let y1 = -1;
            for (let y = top; y <= bottom; y++) {
                for (let x = x0; x <= x1; x++) {
                    if (mask[y * width + x]) {
                        y0 = Math.min(y0, y);
                        y1 = Math.max(y1, y);
                    }
                }
            }
            return {
                x0,
                x1,
                top: y1 < 0 ? null : y0,
                bottom: y1 < 0 ? null : y1,
            };
        });
        // 同时给出较粗的横向统计，避免局部笔画遮蔽整体位置变化；不拟合或命名形状。
        const horizontalSections = Array.from({ length: 3 }, (_, i) => {
            const section = samples.slice(i * 4, i * 4 + 4);
            const present = section.filter(
                (sample) => sample.top !== null && sample.bottom !== null,
            );
            const mean = (field: "top" | "bottom") =>
                present.length
                    ? Math.round(
                          (present.reduce(
                              (sum, sample) => sum + (sample[field] ?? 0),
                              0,
                          ) /
                              present.length) *
                              10,
                      ) / 10
                    : null;
            return {
                x0: section[0].x0,
                x1: section[3].x1,
                meanTop: mean("top"),
                meanBottom: mean("bottom"),
            };
        });
        return [
            {
                bounds: { left, right, top, bottom },
                samples,
                horizontalSections,
            },
        ];
    });
    signal.throwIfAborted();
    return bands.length ? { width, height, bands } : null;
}
