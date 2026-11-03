/** 统一选择文本模型网关与配套凭证，隔离新旧配置并拒绝跨来源拼接。 */
type Environment = Readonly<Record<string, string | undefined>>;

export type TextGateway = Readonly<{ baseUrl?: string; apiKey?: string }>;

const pairs = [
    ["TEXT_MODEL_BASE_URL", "TEXT_MODEL_API_KEY"],
    ["CHARACTER_EMOJI_BASE_URL", "CHARACTER_EMOJI_API_KEY"],
    ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
] as const;

function selectedPair(environment: Environment) {
    return (
        pairs.find(
            ([base, key]) =>
                environment[base]?.trim() || environment[key]?.trim(),
        ) ?? pairs[2]
    );
}

export function textGatewayVariables(
    environment: Environment,
): readonly string[] {
    const pair = selectedPair(environment);
    return pair === pairs[2] ? [pair[1]] : pair;
}

export function resolveTextGateway(environment: Environment): TextGateway {
    const pair = selectedPair(environment);
    const [baseName, keyName] = pair;
    const canonical = pair !== pairs[2];
    const apiKey = environment[keyName]?.trim() || undefined;
    const configuredBase = environment[baseName]?.trim() || undefined;
    if (canonical && (!configuredBase || !apiKey)) {
        throw new Error(`${baseName} 与 ${keyName} 必须同时配置`);
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
