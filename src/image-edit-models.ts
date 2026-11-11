/** 维护图片编辑逻辑模型与 FAL 端点、多媒体网关工具名的精确映射。 */
export const imageEditModels = {
    "gpt-image-2": {
        fal: "openai/gpt-image-2/edit",
        magikaru: "gpt-image-2",
    },
    "gpt-image-2.5-flare": {
        fal: "openai/gpt-image-2.5/flare/edit",
        magikaru: "gpt-image-2.5",
    },
} as const;

export type ImageEditModel = keyof typeof imageEditModels;

export type ImageEditChannel = keyof (typeof imageEditModels)[ImageEditModel];

export function isImageEditModel(model: unknown): model is ImageEditModel {
    return typeof model === "string" && Object.hasOwn(imageEditModels, model);
}

export function resolveImageEditModel(model: string) {
    if (!isImageEditModel(model)) throw new Error("未登记的图片编辑模型");
    return imageEditModels[model];
}
