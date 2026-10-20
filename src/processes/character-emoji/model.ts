/** 注册表情包专用 DeepSeek 4.1 Flash 模型与内存凭证，隔离全局 Pi 配置。 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const characterEmojiModel = "deepseek-v4.1-flash";
export const characterEmojiSearchModel = "deepseek-v4-flash-260425";
export const characterEmojiProvider = "character-emoji";
export type CharacterEmojiModelConfig = Readonly<{
    apiKey: string;
    baseUrl: string;
}>;

export async function createCharacterEmojiModel(
    config: CharacterEmojiModelConfig,
) {
    if (!config.apiKey.trim()) throw new Error("表情包需要配置专用模型凭证");
    const runtime = await ModelRuntime.create({
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
    });
    runtime.registerProvider(characterEmojiProvider, {
        baseUrl: config.baseUrl.replace(/\/+$/u, ""),
        api: "openai-responses",
        models: [
            {
                id: characterEmojiModel,
                name: "表情包 DeepSeek 4.1 Flash",
                reasoning: true,
                thinkingLevelMap: { off: "none", low: "low" },
                input: ["text"],
                // 本地执行上限；零值不作为供应商实际费用证据。
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 65536,
                maxTokens: 8192,
            },
        ],
    });
    await runtime.setRuntimeApiKey(
        characterEmojiProvider,
        config.apiKey.trim(),
    );
    return runtime;
}
