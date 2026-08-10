export type OpenAIImageConfiguration = Readonly<{
    apiKey: string;
    baseUrl?: string;
}>;

export function resolveOpenAIImageConfiguration(
    environment: Readonly<Record<string, string | undefined>>,
): OpenAIImageConfiguration {
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
