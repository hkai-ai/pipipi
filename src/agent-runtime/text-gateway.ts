/** 统一选择文本模型网关与配套凭证，隔离新旧配置并拒绝跨来源拼接。 */
type Environment = Readonly<Record<string, string | undefined>>;

export function textGatewayVariables(
    environment: Environment,
): readonly string[] {
    return environment.CHARACTER_EMOJI_BASE_URL?.trim() ||
        environment.CHARACTER_EMOJI_API_KEY?.trim()
        ? ["CHARACTER_EMOJI_BASE_URL", "CHARACTER_EMOJI_API_KEY"]
        : ["OPENAI_API_KEY"];
}

export function resolveTextGateway(
    environment: Environment,
): Readonly<{ baseUrl?: string; apiKey?: string }> {
    const canonical = textGatewayVariables(environment).includes(
        "CHARACTER_EMOJI_API_KEY",
    );
    const baseName = canonical ? "CHARACTER_EMOJI_BASE_URL" : "OPENAI_BASE_URL";
    const keyName = canonical ? "CHARACTER_EMOJI_API_KEY" : "OPENAI_API_KEY";
    const apiKey = environment[keyName]?.trim() || undefined;
    const configuredBase = environment[baseName]?.trim() || undefined;
    if (canonical && (!configuredBase || !apiKey)) {
        throw new Error(
            "CHARACTER_EMOJI_BASE_URL 与 CHARACTER_EMOJI_API_KEY 必须同时配置",
        );
    }
    const baseUrl =
        configuredBase ?? (apiKey ? "https://api.openai.com/v1" : undefined);
    if (baseUrl) {
        let url: URL;
        try {
            url = new URL(baseUrl);
        } catch {
            throw new Error(`${baseName} 必须是有效网关地址`);
        }
        if (
            !["https:", "http:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        ) {
            throw new Error(
                `${baseName} 必须是无凭证、查询参数和片段的 HTTP(S) 地址`,
            );
        }
    }
    return { ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) };
}
