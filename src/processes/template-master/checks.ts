/** 母版的确定性对照校验：可印、色板、与原图相似度，全部用 sharp 与纯计算，不调用模型。 */
import sharp from "sharp";
import type { DesignSpec } from "../template-from-image/design-spec/vendor/design-spec-schema.js";
import type { MasterTier } from "./contract.js";
import {
    decodeRgba,
    edgeColor,
    hasTransparentPixel,
    type PrintForm,
} from "./light.js";
import {
    ALPHA_FLOOR,
    ALPHA_SOLID,
    ALPHA_VISIBLE,
    ANALYSIS_SIDE,
    HALO_MAX_FOREGROUND_SHARE,
    HALO_MIN_DISTANCE_PX,
    MAX_SIDE,
    MIN_SIDE,
    OPAQUE_FORM_MAX_TRANSPARENT_SHARE,
    PALETTE_MAX_DELTA_E,
    PALETTE_MIN_COVERAGE,
    PALETTE_SAMPLE_SIDE,
    SIMILARITY_MIN_LIGHT,
    SIMILARITY_MIN_MEDIUM,
    SIMILARITY_SIDE,
    STANDALONE_MAX_OPAQUE_SHARE,
    TRUNCATION_MAX_RING_SHARE,
    TRUNCATION_RING_RATIO,
} from "./thresholds.js";

export type CheckResult = Readonly<{
    passed: boolean;
    /** 不含原图文字与颜色值，只写规则与字段名。 */
    detail?: string;
}>;
const pass: CheckResult = { passed: true };
const fail = (detail: string): CheckResult => ({ passed: false, detail });

/** 分析尺度的 RGBA：长边缩到 ANALYSIS_SIDE，保持比例。 */
async function analysisPixels(bytes: Buffer, side: number, nearest = false) {
    const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000 })
        .resize({
            width: side,
            height: side,
            fit: "inside",
            withoutEnlargement: true,
            ...(nearest ? { kernel: "nearest" as const } : {}),
        })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}

/** 到最近实心像素的城市街区距离，两遍扫描。 */
function distanceToSolid(alpha: Uint8Array, width: number, height: number) {
    const far = width + height;
    const distance = new Int32Array(width * height);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            let d = (alpha[i] as number) >= ALPHA_SOLID ? 0 : far;
            if (x > 0) d = Math.min(d, (distance[i - 1] as number) + 1);
            if (y > 0) d = Math.min(d, (distance[i - width] as number) + 1);
            distance[i] = d;
        }
    for (let y = height - 1; y >= 0; y--)
        for (let x = width - 1; x >= 0; x--) {
            const i = y * width + x;
            let d = distance[i] as number;
            if (x < width - 1) d = Math.min(d, (distance[i + 1] as number) + 1);
            if (y < height - 1)
                d = Math.min(d, (distance[i + width] as number) + 1);
            distance[i] = d;
        }
    return distance;
}

/**
 * 可印：standalone 须有透明通道，不透明像素不贴画布边（无截断），整张不是矩形，
 * 远离实心区的半透明像素占前景比例低（无光晕）；rect_patch / bleed_crop 须不透明。
 * 阈值来自 Memebuy 印花验收口径，见 thresholds.ts。
 */
export async function checkPrintable(
    bytes: Buffer,
    form: PrintForm,
): Promise<CheckResult> {
    const meta = await sharp(bytes, {
        limitInputPixels: 40_000_000,
    }).metadata();
    if (meta.format !== "png" || (meta.pages ?? 1) !== 1)
        return fail("成品不是单帧 PNG");
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (
        Math.min(width, height) < MIN_SIDE ||
        Math.max(width, height) > MAX_SIDE
    )
        return fail("尺寸超出可印范围");
    const image = await analysisPixels(bytes, ANALYSIS_SIDE);
    const total = image.width * image.height;
    const alpha = new Uint8Array(total);
    for (let i = 0; i < total; i++) alpha[i] = image.data[i * 4 + 3] as number;
    if (form !== "standalone") {
        let transparent = 0;
        for (const value of alpha) if (value < ALPHA_SOLID) transparent++;
        return transparent / total > OPAQUE_FORM_MAX_TRANSPARENT_SHARE
            ? fail("该印花形态应为不透明画面，成品含透明区")
            : pass;
    }
    if (!meta.hasAlpha) return fail("独立图形缺少透明通道");
    let visible = 0;
    let foreground = 0;
    for (const value of alpha) {
        if (value >= ALPHA_VISIBLE) visible++;
        if (value >= ALPHA_FLOOR) foreground++;
    }
    if (foreground === 0) return fail("成品没有可见前景");
    if (visible === total) return fail("成品没有透明区");
    if (visible / total > STANDALONE_MAX_OPAQUE_SHARE)
        return fail("整张画布几乎不透明，像一整块矩形");
    const ring = Math.max(
        1,
        Math.round(TRUNCATION_RING_RATIO * Math.min(image.width, image.height)),
    );
    let ringTotal = 0;
    let ringOpaque = 0;
    for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
            if (
                x >= ring &&
                x < image.width - ring &&
                y >= ring &&
                y < image.height - ring
            )
                continue;
            ringTotal++;
            if ((alpha[y * image.width + x] as number) >= ALPHA_VISIBLE)
                ringOpaque++;
        }
    if (ringOpaque / ringTotal > TRUNCATION_MAX_RING_SHARE)
        return fail("图案贴到或越出画布边，疑似截断");
    const distance = distanceToSolid(alpha, image.width, image.height);
    let halo = 0;
    for (let i = 0; i < total; i++) {
        const value = alpha[i] as number;
        if (
            value >= ALPHA_FLOOR &&
            value < ALPHA_SOLID &&
            (distance[i] as number) > HALO_MIN_DISTANCE_PX
        )
            halo++;
    }
    return halo / foreground > HALO_MAX_FOREGROUND_SHARE
        ? fail("半透明光晕或雾面占前景比例过高")
        : pass;
}

type Lab = readonly [number, number, number];

export function srgbToLab(r: number, g: number, b: number): Lab {
    const linear = (value: number) => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const [lr, lg, lb] = [linear(r), linear(g), linear(b)] as const;
    const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
    const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175;
    const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / 1.08883;
    const f = (t: number) =>
        t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const [fx, fy, fz] = [f(x), f(y), f(z)] as const;
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export const deltaE = (a: Lab, b: Lab) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** 从颜色描述里取第一个 #rgb / #rrggbb / rgb(r,g,b)；纯颜色名无法确定数值，返回 undefined。 */
export function parseColor(
    text: string,
): readonly [number, number, number] | undefined {
    const hex = /#([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/i.exec(text);
    if (hex) {
        const raw = hex[1] as string;
        const full =
            raw.length === 3
                ? raw
                      .split("")
                      .map((c) => c + c)
                      .join("")
                : raw;
        return [
            Number.parseInt(full.slice(0, 2), 16),
            Number.parseInt(full.slice(2, 4), 16),
            Number.parseInt(full.slice(4, 6), 16),
        ];
    }
    const rgb = /rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/i.exec(
        text,
    );
    if (rgb) {
        const values = [rgb[1], rgb[2], rgb[3]].map(Number);
        if (values.every((value) => value <= 255))
            return values as [number, number, number];
    }
    return undefined;
}

/** designSpec.defaults.colors 中可解析出数值的颜色，附角色 id 供失败说明引用。 */
export function paletteOf(spec: DesignSpec) {
    return Object.entries(spec.defaults.colors).flatMap(([role, text]) => {
        const rgb = parseColor(text);
        return rgb ? [{ role, lab: srgbToLab(...rgb) }] : [];
    });
}

/**
 * 色板：每个可解析的默认颜色在前景里都有足够像素落在色差阈值内；
 * 主体固有色跟随色板（follow_palette）时，前景最主要的颜色也必须在色板内。
 * 默认颜色全是无法解析的颜色名时不判定（返回通过），由模型版面校验与人工兜底。
 */
export async function checkPalette(
    bytes: Buffer,
    spec: DesignSpec,
): Promise<CheckResult> {
    const palette = paletteOf(spec);
    if (palette.length === 0) return pass;
    const image = await analysisPixels(bytes, PALETTE_SAMPLE_SIDE, true);
    const total = image.width * image.height;
    const counts = new Array<number>(palette.length).fill(0);
    const buckets = new Map<number, { count: number; rgb: number[] }>();
    let foreground = 0;
    for (let i = 0; i < total; i++) {
        const o = i * 4;
        if ((image.data[o + 3] as number) < ALPHA_VISIBLE) continue;
        foreground++;
        const r = image.data[o] as number;
        const g = image.data[o + 1] as number;
        const b = image.data[o + 2] as number;
        const lab = srgbToLab(r, g, b);
        palette.forEach((entry, index) => {
            if (deltaE(lab, entry.lab) <= PALETTE_MAX_DELTA_E)
                counts[index] = (counts[index] as number) + 1;
        });
        const key = (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3);
        const bucket = buckets.get(key) ?? { count: 0, rgb: [0, 0, 0] };
        bucket.count++;
        bucket.rgb[0] = (bucket.rgb[0] as number) + r;
        bucket.rgb[1] = (bucket.rgb[1] as number) + g;
        bucket.rgb[2] = (bucket.rgb[2] as number) + b;
        buckets.set(key, bucket);
    }
    if (foreground === 0) return fail("成品没有可见前景，无法核对配色");
    const missing = palette
        .filter(
            (_, index) =>
                (counts[index] as number) / foreground < PALETTE_MIN_COVERAGE,
        )
        .map((entry) => entry.role);
    if (missing.length) return fail(`配色缺失：${missing.join("、")}`);
    const follows = spec.elements.some(
        (element) =>
            element.category === "subject" &&
            element.inherentColorPolicy === "follow_palette",
    );
    if (follows) {
        const dominant = [...buckets.values()].reduce((a, b) =>
            b.count > a.count ? b : a,
        );
        const lab = srgbToLab(
            ...(dominant.rgb.map((v) => v / dominant.count) as [
                number,
                number,
                number,
            ]),
        );
        if (
            !palette.some(
                (entry) => deltaE(lab, entry.lab) <= PALETTE_MAX_DELTA_E,
            )
        )
            return fail("主色不在默认色板内");
    }
    return pass;
}

/** 32×32 灰度图的 Pearson 相关；透明处铺在 backdrop 上，两图都扁平化后再比。 */
async function lumaGrid(bytes: Buffer, backdrop: readonly number[]) {
    const { data } = await sharp(bytes, { limitInputPixels: 40_000_000 })
        .rotate()
        .flatten({
            background: {
                r: backdrop[0] as number,
                g: backdrop[1] as number,
                b: backdrop[2] as number,
            },
        })
        .resize({
            width: SIMILARITY_SIDE,
            height: SIMILARITY_SIDE,
            fit: "fill",
        })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return Array.from(data);
}

function correlation(a: readonly number[], b: readonly number[]): number {
    const mean = (v: readonly number[]) =>
        v.reduce((s, x) => s + x, 0) / v.length;
    const [ma, mb] = [mean(a), mean(b)] as const;
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < a.length; i++) {
        const da = (a[i] as number) - ma;
        const db = (b[i] as number) - mb;
        cov += da * db;
        va += da * da;
        vb += db * db;
    }
    if (va < 1e-6 && vb < 1e-6) return Math.abs(ma - mb) < 8 ? 1 : 0;
    if (va < 1e-6 || vb < 1e-6) return 0;
    return Math.max(0, cov / Math.sqrt(va * vb));
}

/**
 * 与原图相似度：轻、中档才比，重档不比（返回 null）。原图有透明时两图铺白，
 * 否则铺在原图边缘底色上，使去掉衬底的成品与原图可比。阈值见 thresholds.ts。
 */
export async function checkSimilarity(
    master: Buffer,
    source: Buffer,
    tier: MasterTier,
): Promise<(CheckResult & { score: number }) | null> {
    if (tier === "heavy") return null;
    const rgba = await decodeRgba(source, 512);
    const backdrop = hasTransparentPixel(rgba)
        ? [255, 255, 255]
        : edgeColor(rgba).color;
    const score = Number(
        correlation(
            await lumaGrid(source, backdrop),
            await lumaGrid(master, backdrop),
        ).toFixed(3),
    );
    const minimum =
        tier === "light" ? SIMILARITY_MIN_LIGHT : SIMILARITY_MIN_MEDIUM;
    return score >= minimum
        ? { passed: true, score }
        : { passed: false, score, detail: "与原图差异过大" };
}
