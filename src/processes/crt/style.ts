/** 固定调色板、画幅 */
export const crtPaletteNames = [
    "经典",
    "粉黛",
    "极客01",
    "极客02",
    "复古01",
    "复古02",
    "游戏01",
    "游戏02",
    "如图",
] as const;

export type CrtPalette = (typeof crtPaletteNames)[number];

export const crtAspectRatios = ["3:4", "4:3", "9:16", "16:9"] as const;

export type CrtAspectRatio = (typeof crtAspectRatios)[number];

export const crtGrains = ["fine", "normal", "coarse"] as const;

export type CrtGrain = (typeof crtGrains)[number];

export const defaultCrtGrain: CrtGrain = "normal";

export type CrtGrainProfile = Readonly<{
    blockSize: number;
    scanlinePeriod: number;
}>;

/**
 * Block size and scanline period ship as one named preset because they are
 * independent knobs whose ratio is what the eye reads. Exposing `blockSize`
 * alone would let callers drift that ratio into combinations no one has
 * reviewed. `normal` reproduces the treatment that existed before grains.
 */
const grainProfiles = Object.freeze({
    fine: Object.freeze({ blockSize: 2, scanlinePeriod: 4 }),
    normal: Object.freeze({ blockSize: 4, scanlinePeriod: 6 }),
    coarse: Object.freeze({ blockSize: 8, scanlinePeriod: 12 }),
} satisfies Record<CrtGrain, CrtGrainProfile>);

export function grainProfile(grain: CrtGrain): CrtGrainProfile {
    return grainProfiles[grain];
}

const namedPaletteColors = Object.freeze({
    经典: Object.freeze(["#dee4e0", "#2e382d"]),
    粉黛: Object.freeze(["#f2d1d7", "#7a3f43"]),
    极客01: Object.freeze(["#f2fcf6", "#485446", "#111e16", "#13f81f"]),
    极客02: Object.freeze(["#e8e5df", "#2ca770", "#0d3d2d", "#3e6a9e"]),
    复古01: Object.freeze([
        "#efca54",
        "#5d9f58",
        "#e870a1",
        "#bbb8a5",
        "#49473c",
    ]),
    复古02: Object.freeze([
        "#e5e2be",
        "#ef8a45",
        "#317e50",
        "#8e6442",
        "#35342f",
    ]),
    游戏01: Object.freeze([
        "#22e6da",
        "#fabf37",
        "#e90cbe",
        "#2a4ac5",
        "#1d2c6b",
    ]),
    游戏02: Object.freeze([
        "#e7f5fe",
        "#7bd699",
        "#3bc4c4",
        "#c97979",
        "#29383a",
    ]),
} satisfies Record<Exclude<CrtPalette, "如图">, readonly string[]>);

export function paletteColors(
    palette: CrtPalette,
): readonly string[] | undefined {
    return palette === "如图" ? undefined : namedPaletteColors[palette];
}

export function ratioValue(aspectRatio: CrtAspectRatio): number {
    const [width, height] = aspectRatio.split(":");
    return Number(width) / Number(height);
}
