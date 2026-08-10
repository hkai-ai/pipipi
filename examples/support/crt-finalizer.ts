import sharp from "sharp";
import {
    type CrtAspectRatio,
    type CrtPalette,
    paletteColors,
} from "../../src/processes/crt/style.js";

export type FinalizedCrtImage = Readonly<{
    bytes: Buffer;
    width: number;
    height: number;
    colors: readonly string[];
    blockSize: number;
}>;

const dimensions = Object.freeze({
    "3:4": Object.freeze({ width: 1200, height: 1600 }),
    "4:3": Object.freeze({ width: 1600, height: 1200 }),
    "9:16": Object.freeze({ width: 1152, height: 2048 }),
    "16:9": Object.freeze({ width: 2048, height: 1152 }),
} satisfies Record<CrtAspectRatio, { width: number; height: number }>);

type Rgb = Readonly<{ red: number; green: number; blue: number }>;

export function crtImageDimensions(
    aspectRatio: CrtAspectRatio,
): Readonly<{ width: number; height: number }> {
    return dimensions[aspectRatio];
}

/**
 * Independently authored deterministic CRT treatment for the local acceptance
 * harness. It deliberately uses only the reviewed output constraints, not the
 * upstream Skill's unlicensed implementation script.
 */
export async function finalizeCrtImage(input: {
    generated: Uint8Array;
    source: Uint8Array;
    palette: CrtPalette;
    aspectRatio: CrtAspectRatio;
}): Promise<FinalizedCrtImage> {
    const { width, height } = crtImageDimensions(input.aspectRatio);
    const colors = await resolveColors(input.palette, input.source);
    const rgb = colors.map(parseHexColor).sort(compareLuminance);
    const blockSize = 4;
    const lowWidth = Math.ceil(width / blockSize);
    const lowHeight = Math.ceil(height / blockSize);
    const { data: low, info } = await sharp(input.generated)
        .rotate()
        .resize(lowWidth, lowHeight, {
            fit: "fill",
            kernel: sharp.kernel.nearest,
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    if (info.channels < 3) {
        throw new Error("CRT finalizer requires an RGB raster");
    }

    const output = Buffer.allocUnsafe(width * height * 3);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const source = distortedSourcePixel({
                x,
                y,
                width,
                height,
                lowWidth,
                lowHeight,
                low,
                channels: info.channels,
            });
            let colorIndex = nearestColorIndex(source, rgb);
            colorIndex = applyCrtSignals({
                colorIndex,
                colors: rgb,
                x,
                y,
                width,
                height,
                blockSize,
            });
            setPixel(output, width, x, y, rgb[colorIndex]);
        }
    }
    drawSignature(output, width, height, rgb);

    const bytes = await sharp(output, {
        raw: { width, height, channels: 3 },
    })
        .png({ compressionLevel: 9, palette: false })
        .toBuffer();
    return Object.freeze({
        bytes,
        width,
        height,
        colors: Object.freeze(rgb.map(formatHexColor)),
        blockSize,
    });
}

async function resolveColors(
    palette: CrtPalette,
    source: Uint8Array,
): Promise<readonly string[]> {
    const named = paletteColors(palette);
    if (named) return named;

    const { data, info } = await sharp(source)
        .rotate()
        .resize(64, 64, { fit: "inside", withoutEnlargement: true })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    if (info.channels < 3 || data.length === 0) {
        throw new Error("CRT source image has no RGB pixels");
    }
    const samples: Rgb[] = [];
    for (let offset = 0; offset < data.length; offset += info.channels) {
        samples.push({
            red: data[offset] ?? 0,
            green: data[offset + 1] ?? 0,
            blue: data[offset + 2] ?? 0,
        });
    }
    samples.sort(compareLuminance);
    const selected = [0, 0.25, 0.5, 0.75, 1].map(
        (quantile) =>
            samples[Math.round((samples.length - 1) * quantile)] ?? samples[0],
    );
    const unique = uniqueColors(selected).sort(compareLuminance);
    if (unique.length === 1) {
        const only = unique[0];
        unique.unshift(scaleColor(only, 0.45));
        unique.push(mixColor(only, { red: 255, green: 255, blue: 255 }, 0.55));
    }
    return unique.slice(0, 5).map(formatHexColor);
}

function distortedSourcePixel(options: {
    x: number;
    y: number;
    width: number;
    height: number;
    lowWidth: number;
    lowHeight: number;
    low: Buffer;
    channels: number;
}): Rgb {
    const normalizedX = (options.x / Math.max(1, options.width - 1)) * 2 - 1;
    const normalizedY = (options.y / Math.max(1, options.height - 1)) * 2 - 1;
    const radius = Math.sqrt(normalizedX ** 2 + normalizedY ** 2);
    const edge = clamp((radius - 0.72) / 0.7, 0, 1);
    const barrelScale = 1 - 0.075 * edge ** 2;
    const sourceX = clamp(
        Math.round(
            ((normalizedX * barrelScale + 1) / 2) * (options.lowWidth - 1),
        ),
        0,
        options.lowWidth - 1,
    );
    const sourceY = clamp(
        Math.round(
            ((normalizedY * barrelScale + 1) / 2) * (options.lowHeight - 1),
        ),
        0,
        options.lowHeight - 1,
    );
    const offset = (sourceY * options.lowWidth + sourceX) * options.channels;
    return {
        red: options.low[offset] ?? 0,
        green: options.low[offset + 1] ?? 0,
        blue: options.low[offset + 2] ?? 0,
    };
}

function applyCrtSignals(options: {
    colorIndex: number;
    colors: readonly Rgb[];
    x: number;
    y: number;
    width: number;
    height: number;
    blockSize: number;
}): number {
    let index = options.colorIndex;
    const scanline = options.y % 6;
    if (scanline >= 4 && index > 0) index -= 1;

    const checker =
        (Math.floor(options.x / (options.blockSize * 2)) +
            Math.floor(options.y / (options.blockSize * 2))) %
        2;
    if (checker === 1 && index > 0 && index < options.colors.length - 1) {
        index += 1;
    }

    const edgeDistance = Math.min(
        options.x / options.width,
        (options.width - options.x - 1) / options.width,
        options.y / options.height,
        (options.height - options.y - 1) / options.height,
    );
    if (edgeDistance < 0.1 && (options.x * 17 + options.y * 31) % 97 < 5) {
        index = (index + 1) % options.colors.length;
    }
    return index;
}

const glyphs: Readonly<Record<string, readonly string[]>> = Object.freeze({
    a: ["01110", "10001", "11111", "10001", "10001", "10001", "10001"],
    c: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    e: ["11111", "10000", "11110", "10000", "10000", "10000", "11111"],
    f: ["11111", "10000", "11110", "10000", "10000", "10000", "10000"],
    i: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    k: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    l: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    n: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    r: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    s: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    t: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
});

function drawSignature(
    output: Buffer,
    width: number,
    height: number,
    colors: readonly Rgb[],
): void {
    const text = "tait-crt-interface-skill";
    const scale = Math.max(2, Math.floor(width / 900));
    const glyphWidth = 5 * scale;
    const spacing = scale;
    const textWidth = text.length * (glyphWidth + spacing) - spacing;
    const margin = Math.max(16, Math.round(Math.min(width, height) * 0.018));
    const padding = scale * 4;
    const originX = Math.max(margin, width - margin - textWidth - padding * 2);
    const originY = margin;
    const background = colors[colors.length - 1];
    const foreground = colors[0];
    fillRectangle(
        output,
        width,
        height,
        originX - padding,
        originY - padding,
        textWidth + padding * 2,
        7 * scale + padding * 2,
        background,
    );
    for (
        let characterIndex = 0;
        characterIndex < text.length;
        characterIndex += 1
    ) {
        const glyph = glyphs[text[characterIndex]];
        if (!glyph) continue;
        for (let row = 0; row < glyph.length; row += 1) {
            for (let column = 0; column < glyph[row].length; column += 1) {
                if (glyph[row][column] !== "1") continue;
                fillRectangle(
                    output,
                    width,
                    height,
                    originX +
                        characterIndex * (glyphWidth + spacing) +
                        column * scale,
                    originY + row * scale,
                    scale,
                    scale,
                    foreground,
                );
            }
        }
    }
}

function fillRectangle(
    output: Buffer,
    width: number,
    height: number,
    x: number,
    y: number,
    rectangleWidth: number,
    rectangleHeight: number,
    color: Rgb,
): void {
    const endX = Math.min(width, x + rectangleWidth);
    const endY = Math.min(height, y + rectangleHeight);
    for (let targetY = Math.max(0, y); targetY < endY; targetY += 1) {
        for (let targetX = Math.max(0, x); targetX < endX; targetX += 1) {
            setPixel(output, width, targetX, targetY, color);
        }
    }
}

function setPixel(
    output: Buffer,
    width: number,
    x: number,
    y: number,
    color: Rgb,
): void {
    const offset = (y * width + x) * 3;
    output[offset] = color.red;
    output[offset + 1] = color.green;
    output[offset + 2] = color.blue;
}

function nearestColorIndex(color: Rgb, colors: readonly Rgb[]): number {
    let nearest = 0;
    let smallestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < colors.length; index += 1) {
        const candidate = colors[index];
        const distance =
            (color.red - candidate.red) ** 2 * 0.3 +
            (color.green - candidate.green) ** 2 * 0.59 +
            (color.blue - candidate.blue) ** 2 * 0.11;
        if (distance < smallestDistance) {
            smallestDistance = distance;
            nearest = index;
        }
    }
    return nearest;
}

function parseHexColor(value: string): Rgb {
    const match = /^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/iu.exec(value);
    if (!match) throw new Error(`Invalid CRT palette color: ${value}`);
    return {
        red: Number.parseInt(match[1], 16),
        green: Number.parseInt(match[2], 16),
        blue: Number.parseInt(match[3], 16),
    };
}

function formatHexColor(color: Rgb): string {
    return `#${hex(color.red)}${hex(color.green)}${hex(color.blue)}`;
}

function hex(value: number): string {
    return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

function compareLuminance(left: Rgb, right: Rgb): number {
    return luminance(left) - luminance(right);
}

function luminance(color: Rgb): number {
    return color.red * 0.2126 + color.green * 0.7152 + color.blue * 0.0722;
}

function uniqueColors(colors: readonly Rgb[]): Rgb[] {
    const seen = new Set<string>();
    return colors.filter((color) => {
        const key = `${color.red},${color.green},${color.blue}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function scaleColor(color: Rgb, scale: number): Rgb {
    return {
        red: Math.round(color.red * scale),
        green: Math.round(color.green * scale),
        blue: Math.round(color.blue * scale),
    };
}

function mixColor(left: Rgb, right: Rgb, amount: number): Rgb {
    return {
        red: Math.round(left.red * (1 - amount) + right.red * amount),
        green: Math.round(left.green * (1 - amount) + right.green * amount),
        blue: Math.round(left.blue * (1 - amount) + right.blue * amount),
    };
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}
