/** 图片生成 Business Capability 的装配 Interface：按 IMAGE_PROVIDER 从环境变量选择 OpenAI 或 FAL Adapter */
import {
    FalImageGenerationClient,
    type FalImageGenerationClientOptions,
} from "./fal-image-generation.js";
import {
    type EditImageRequest,
    type GeneratedImage,
    type GenerateImageRequest,
    OpenAIImageGenerationClient,
} from "./openai-image-generation.js";

export type ImageGenerationProvider = "openai" | "fal";

export type ImageGenerationClient = Readonly<{
    generate: (request: GenerateImageRequest) => Promise<GeneratedImage>;
    edit: (request: EditImageRequest) => Promise<GeneratedImage>;
}>;

export type ImageGeneration = Readonly<{
    provider: ImageGenerationProvider;
    client: ImageGenerationClient;
}>;

export function createImageGenerationClient(
    environment: Readonly<Record<string, string | undefined>>,
    options: Readonly<{ timeoutMs?: number }> = {},
): ImageGeneration {
    const provider = parseProvider(environment.IMAGE_PROVIDER);
    if (provider === "fal") {
        const apiKey = environment.FAL_KEY?.trim();
        if (!apiKey)
            throw new Error("FAL_KEY is required when IMAGE_PROVIDER=fal");
        const clientOptions: FalImageGenerationClientOptions = {
            apiKey,
            ...(options.timeoutMs === undefined
                ? {}
                : { timeoutMs: options.timeoutMs }),
        };
        return Object.freeze({
            provider,
            client: new FalImageGenerationClient(clientOptions),
        });
    }

    return Object.freeze({
        provider,
        client: new OpenAIImageGenerationClient({
            ...resolveOpenAIConfiguration(environment),
            ...(options.timeoutMs === undefined
                ? {}
                : { timeoutMs: options.timeoutMs }),
        }),
    });
}

function parseProvider(value: string | undefined): ImageGenerationProvider {
    const provider = value?.trim() || "openai";
    if (provider === "openai" || provider === "fal") return provider;
    throw new Error("IMAGE_PROVIDER must be openai or fal");
}

function resolveOpenAIConfiguration(
    environment: Readonly<Record<string, string | undefined>>,
): Readonly<{ apiKey: string; baseUrl?: string }> {
    const apiKey =
        environment.OPENAI_IMAGE_API_KEY?.trim() ||
        environment.OPENAI_API_KEY?.trim();
    if (!apiKey) {
        throw new Error("OPENAI_IMAGE_API_KEY or OPENAI_API_KEY is required");
    }
    const baseUrl =
        environment.OPENAI_IMAGE_BASE_URL?.trim() ||
        environment.OPENAI_BASE_URL?.trim();
    return Object.freeze({
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
    });
}
