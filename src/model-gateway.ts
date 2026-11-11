/** 统一解析模型网关及旧配置别名，并独立保留图片渠道的启用规则。 */
type Environment = Readonly<Record<string, string | undefined>>;
export type ModelGateway = Readonly<{ baseUrl?: string; apiKey?: string }>;
type Channel = "text" | "image" | "character-image";
type Pair = readonly [string, string];
const shared: Pair = ["MODEL_GATEWAY_BASE_URL", "MODEL_GATEWAY_API_KEY"];
const openai: Pair = ["OPENAI_BASE_URL", "OPENAI_API_KEY"];
const image: Pair = ["OPENAI_IMAGE_BASE_URL", "OPENAI_IMAGE_API_KEY"];
const characterImage: Pair = [
    "CHARACTER_EMOJI_IMAGE_BASE_URL",
    "CHARACTER_EMOJI_IMAGE_API_KEY",
];
const textPairs: readonly Pair[] = [
    shared,
    ["TEXT_MODEL_BASE_URL", "TEXT_MODEL_API_KEY"],
    ["CHARACTER_EMOJI_BASE_URL", "CHARACTER_EMOJI_API_KEY"],
    openai,
];
function hasValue(environment: Environment, pair: Pair) {
    return pair.some((name) => Boolean(environment[name]?.trim()));
}
function selectedPair(
    environment: Environment,
    channel: Channel,
): Pair | undefined {
    if (channel === "character-image") {
        const flag = environment.CHARACTER_EMOJI_IMAGE_ENABLED?.trim();
        if (flag && flag !== "true" && flag !== "false")
            throw new Error(
                "CHARACTER_EMOJI_IMAGE_ENABLED 必须是 true 或 false",
            );
        if (flag === "false") return undefined;
        if (!flag && !environment.CHARACTER_EMOJI_IMAGE_API_KEY?.trim()) {
            if (environment.CHARACTER_EMOJI_IMAGE_BASE_URL?.trim())
                throw new Error(
                    "配置图片主用地址时必须配置 CHARACTER_EMOJI_IMAGE_API_KEY",
                );
            return undefined;
        }
        return hasValue(environment, shared) ||
            !hasValue(environment, characterImage)
            ? shared
            : characterImage;
    }
    const pairs = channel === "text" ? textPairs : [image, shared, openai];
    return (
        pairs.find((pair) => hasValue(environment, pair)) ??
        (channel === "image" ? shared : openai)
    );
}
export function modelGatewayVariables(
    environment: Environment,
    channel: Channel = "text",
): readonly string[] {
    const pair = selectedPair(environment, channel);
    if (!pair) return [];
    return pair === openai || pair === image || pair === characterImage
        ? [pair[1]]
        : pair;
}
export function resolveModelGateway(
    environment: Environment,
    channel: Channel = "text",
): ModelGateway {
    const pair = selectedPair(environment, channel);
    if (!pair) return {};
    const [baseName, keyName] = pair;
    const apiKey = environment[keyName]?.trim() || undefined;
    const configuredBase = environment[baseName]?.trim() || undefined;
    const requiresPair =
        pair !== openai && pair !== image && pair !== characterImage;
    if (
        (requiresPair && (!configuredBase || !apiKey)) ||
        (pair !== openai && configuredBase && !apiKey)
    )
        throw new Error(`${baseName} 与 ${keyName} 必须同时配置`);
    const baseUrl =
        configuredBase ??
        (apiKey
            ? pair === characterImage
                ? "https://llmapi.memene.cn/openai/v1"
                : "https://api.openai.com/v1"
            : undefined);
    if (baseUrl) {
        let url: URL;
        try {
            url = new URL(baseUrl);
        } catch {
            throw new Error(`${baseName} 必须是有效网关地址`);
        }
        const protocols =
            channel === "character-image" ? ["https:"] : ["https:", "http:"];
        if (
            !protocols.includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        )
            throw new Error(
                `${baseName} 必须是无凭证、查询参数和片段的 ${channel === "character-image" ? "HTTPS" : "HTTP(S)"} 地址`,
            );
    }
    if (channel !== "text" && !apiKey)
        throw new Error("图片模型需要配置网关凭证");
    return { ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) };
}
