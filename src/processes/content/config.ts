/** Business API Base URL 的解析与校验 */
const invalidBusinessApiBaseUrlMessage =
    "BUSINESS_API_BASE_URL must be a valid HTTP(S) URL without credentials";

export function parseBusinessApiBaseUrl(value: string | undefined): string {
    const candidate = value?.trim();
    if (!candidate) throw new Error("BUSINESS_API_BASE_URL is required");

    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        throw new Error(invalidBusinessApiBaseUrlMessage);
    }

    if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username.length > 0 ||
        url.password.length > 0
    ) {
        throw new Error(invalidBusinessApiBaseUrlMessage);
    }
    return url.toString();
}
