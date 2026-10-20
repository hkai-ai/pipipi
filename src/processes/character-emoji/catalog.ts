/** 固定表情包角色清单及其受控参考图地址。 */
export const characters = [
    { id: "DeepSeek", name: "DeepSeek" },
    { id: "Claude", name: "Claude" },
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

const referenceImages: Record<CharacterId, Record<Appearance, string>> = {
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

export function imageUrl(
    character: CharacterId,
    appearance: Appearance,
): string {
    return referenceImages[character][appearance];
}

export function characterName(character: CharacterId): string {
    return characters.find((item) => item.id === character)?.name ?? character;
}
