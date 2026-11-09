/** 照片海报风格的准确身份、名称、顺序与画幅。 */
export const photoPosterStyles = [
    "dopamine",
    "mono-color",
    "travel-abstraction",
    "crayon",
    "monochrome",
    "woodcut",
    "photo-doodle-collage",
    "photo-fashion-manga",
    "manga-panels",
    "memory-checklist",
    "risograph-album",
] as const;

export type PhotoPosterStyle = (typeof photoPosterStyles)[number];

export const photoPosterNames: Readonly<Record<PhotoPosterStyle, string>> = {
    dopamine: "多巴胺摄影插画海报",
    "mono-color": "双色油墨图文海报",
    "travel-abstraction": "摄影抽象记忆海报",
    crayon: "彩色蜡笔抽象海报",
    monochrome: "黑白蜡笔摄影海报",
    woodcut: "限色木刻摄影海报",
    "photo-doodle-collage": "摄影剪贴与涂鸦小人海报",
    "photo-fashion-manga": "日式时装漫画",
    "manga-panels": "漫画分镜",
    "memory-checklist": "上下分屏记忆清单海报",
    "risograph-album": "复古音乐专辑封面",
};

const portrait = { width: 1_200, height: 1_600 } as const;

export const photoPosterCanvas: Readonly<
    Record<
        PhotoPosterStyle,
        { readonly width: number; readonly height: number }
    >
> = {
    dopamine: portrait,
    "mono-color": portrait,
    "travel-abstraction": portrait,
    crayon: portrait,
    monochrome: portrait,
    woodcut: portrait,
    "photo-doodle-collage": portrait,
    "photo-fashion-manga": portrait,
    "manga-panels": portrait,
    "memory-checklist": portrait,
    "risograph-album": { width: 1_200, height: 1_200 },
};

export function photoPosterPixelSize(style: PhotoPosterStyle): string {
    const canvas = photoPosterCanvas[style];
    return `${canvas.width}x${canvas.height}`;
}

/** 服务端拥有的画幅与版式。记忆清单保留上半原片；唱片封面为方形。 */
export function photoPosterCanvasInstruction(style: PhotoPosterStyle): string {
    if (style === "memory-checklist")
        return "\nOutput one standalone 1200x1600 PNG, exactly 3:4. Split the canvas into two equal horizontal halves. The upper half retains the reference photograph: identity, pose, lighting and setting, with only a light editorial grade. The lower half redraws exactly nine recognizable details that are actually visible in that photograph as a loose 3x3 naive crayon doodle, with one handwritten English title above the grid and one tiny English caption below. Do not illustrate the upper half. Do not place the photograph in the lower half. Do not invent objects that are absent from the photograph.";
    if (style === "risograph-album")
        return "\nOutput one standalone 1200x1200 PNG, exactly 1:1. Use the entire canvas for one album cover. Place a waist-up profile of the same person in the left third, with the head and shoulders fully inside the frame and a large bright-yellow field on the right. Render navy halftone on the figure and yellow halftone on the ground, with a clear Risograph print grain. Print the red handwritten words i'm ok on the upper right and the small black sans-serif words HAPPY EVERYDAY directly beneath them. Keep the person's face, hair and clothing recognizable. Do not add any other lettering.";
    if (style === "manga-panels")
        return "\nOutput one standalone 1200x1600 PNG, exactly 3:4. Use the entire canvas for the stylized artwork: one complete manga page containing the three specified picture panels. Every panel is redrawn; never include an original-photo region or before/after comparison.";
    return "\nOutput one standalone 1200x1600 PNG, exactly 3:4. Use the entire canvas for the stylized artwork. The reference photograph is input only: never include an original-photo region, split-screen, before/after comparison or collage.";
}

export function photoPosterProcessId(style: PhotoPosterStyle): string {
    if (
        style === "photo-doodle-collage" ||
        style === "photo-fashion-manga" ||
        style === "manga-panels" ||
        style === "risograph-album"
    )
        return style;
    return `${style}-photo-poster`;
}
