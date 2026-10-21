/** 固定表情包角色清单及其受控参考图地址。 */
export const characters = [
    { id: "DeepSeek", name: "DeepSeek" },
    { id: "Claude", name: "Claude" },
    { id: "Doubao", name: "豆包" },
    { id: "GLM", name: "智谱 GLM" },
    { id: "Gemini", name: "Gemini" },
    { id: "ChatGPT", name: "ChatGPT" },
    { id: "Qwen", name: "通义 Qwen" },
    { id: "Grok", name: "Grok" },
    { id: "Kimi", name: "Kimi" },
    { id: "MiniMax", name: "MiniMax" },
    { id: "GLM-Fox", name: "智谱 · 狐娘" },
] as const;

export type CharacterId = (typeof characters)[number]["id"];
export type Appearance = "Chibi" | "Girl";
export const appearanceLabels: Record<Appearance, string> = {
    Chibi: "Q 版",
    Girl: "少女版",
};

const referenceImages: Record<
    CharacterId,
    Partial<Record<Appearance, string>>
> = {
    Doubao: {
        Chibi: "https://assets.memebuy.cn/maker/characters/community/scenes/doubao/chibi-5e7e8f7823faaa50.png",
    },
    DeepSeek: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/deepseek/chibi-b343bab8a5b6e7f2.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/deepseek/girl-c2d0a919cd14f1ec.png",
    },
    Claude: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/claude/chibi-6823bdd4b873610c.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/claude/girl-6cdd47019c6f80fb.png",
    },
    GLM: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/glm/chibi-d865b26cb2a7d7ee.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/glm/girl-cde6dc0eaa3dbe70.png",
    },
    Gemini: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/gemini/chibi-dbb28bb51caa3889.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/gemini/girl-2eb9def68bb78bd9.png",
    },
    ChatGPT: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/chatgpt/chibi-546223ab14b24ae7.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/chatgpt/girl-c5cbe211d6914099.png",
    },
    Qwen: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/qwen/chibi-750172b4f5eda649.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/qwen/girl-9ebe31a29b07d6ef.png",
    },
    Grok: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/grok/chibi-2a3af1fad7eb6c47.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/grok/girl-84a9c2ed08a69152.png",
    },
    Kimi: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/kimi/chibi-d4f6c390e542cccb.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/kimi/girl-61af30ec7f0f4ca3.png",
    },
    MiniMax: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/minimax/chibi-e49537c73e22e713.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/minimax/girl-76fba61501c707ea.png",
    },
    "GLM-Fox": {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/glm-fox/chibi-74b13896f59e8949.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/glm-fox/girl-ae4312095d68ce92.png",
    },
};

// v3 与 Memebuy 场景版素材一致；旧版本继续使用原参考图。
const sceneReferenceImages: Record<
    CharacterId,
    Partial<Record<Appearance, string>>
> = {
    DeepSeek: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/deepseek/chibi-b7d2e845ee567c16.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/deepseek/girl-4e9c6637cad5b663.png",
    },
    Claude: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/claude/chibi-0b3b7137a0ab5cdf.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/claude/girl-268d514f648e78a2.png",
    },
    GLM: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/glm/chibi-33ef2b2e2cc7ccc5.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/glm/girl-60c054edaa601a6a.png",
    },
    "GLM-Fox": {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/glm-fox/chibi-e29d345377c3aa20.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/glm-fox/girl-e09f9b806296a505.png",
    },
    ChatGPT: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/chatgpt/chibi-862f63516eda9030.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/chatgpt/girl-6e1bc481dbcf1fae.png",
    },
    Gemini: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/gemini/chibi-c156d0ea26d8c76e.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/gemini/girl-3bb108f5d25dc634.png",
    },
    Grok: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/grok/chibi-c5234205b3d16992.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/grok/girl-96eaa9c4e4f72bb1.png",
    },
    Kimi: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/kimi/chibi-6b40444e6a543c42.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/kimi/girl-2ba462bcbd9323b8.png",
    },
    MiniMax: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/minimax/chibi-5b6d3a78d50a0740.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/minimax/girl-ade7f207a5e75a6f.png",
    },
    Qwen: {
        Chibi: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/qwen/chibi-d7da4e6c844b4d61.png",
        Girl: "https://assets.memebuy.cn/maker/characters/ai-fanworks/scenes/qwen/girl-21f2ca66d73eabbb.png",
    },
    Doubao: {
        Chibi: "https://assets.memebuy.cn/maker/characters/community/scenes/doubao/chibi-5e7e8f7823faaa50.png",
    },
};

export function imageUrl(
    character: CharacterId,
    appearance: Appearance,
    version: "v2" | "v3" = "v2",
): string {
    const url = (version === "v3" ? sceneReferenceImages : referenceImages)[
        character
    ][appearance];
    if (!url) throw new Error("该角色暂不支持此形象版本");
    return url;
}

export const hasAppearance = (character: CharacterId, appearance: Appearance) =>
    Boolean(referenceImages[character][appearance]);

export function characterName(character: CharacterId): string {
    return characters.find((item) => item.id === character)?.name ?? character;
}
