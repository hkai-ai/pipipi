/** 照片海报风格的准确身份、名称与顺序。 */
export const photoPosterStyles = [
    "dopamine",
    "mono-color",
    "travel-abstraction",
    "crayon",
    "monochrome",
    "woodcut",
    "photo-doodle-collage",
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
};

export function photoPosterProcessId(style: PhotoPosterStyle): string {
    if (style === "photo-doodle-collage") return "photo-doodle-collage";
    return `${style}-photo-poster`;
}
