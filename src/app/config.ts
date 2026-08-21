/** 从启动环境字符串解析端口、正整数、布尔值、连接 URL 等基础配置值并校验合法性 */
export type StartupEnvironment = Readonly<Record<string, string | undefined>>;

export function parsePort(value: string | undefined): number {
    if (value === undefined) return 3000;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }
    return port;
}

export function parsePositiveInteger(
    value: string | undefined,
    fallback: number,
    name: string,
): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

export function parseRequiredPositiveInteger(
    value: string | undefined,
    name: string,
    missingMessage: string,
): number {
    if (value === undefined) throw new Error(missingMessage);
    return parsePositiveInteger(value, 1, name);
}

export function parseBoundedPositiveInteger(
    value: string | undefined,
    fallback: number,
    name: string,
    maximum: number,
): number {
    const parsed = parsePositiveInteger(value, fallback, name);
    if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);
    return parsed;
}

export function parseBoundedNonNegativeInteger(
    value: string | undefined,
    fallback: number,
    name: string,
    maximum: number,
): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
        throw new Error(`${name} must be an integer between 0 and ${maximum}`);
    }
    return parsed;
}

export function parseBoolean(
    value: string | undefined,
    fallback: boolean,
    name: string,
): boolean {
    if (value === undefined) return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`${name} must be true or false`);
}

export function parseConnectionUrl(
    value: string | undefined,
    options: {
        protocols: readonly string[];
        missingMessage: string;
        invalidMessage: string;
        requirePath?: boolean;
    },
): string {
    const candidate = value?.trim();
    if (!candidate) throw new Error(options.missingMessage);
    try {
        const url = new URL(candidate);
        if (
            !options.protocols.includes(url.protocol) ||
            url.hostname.length === 0 ||
            (options.requirePath && url.pathname.length <= 1)
        ) {
            throw new Error();
        }
    } catch {
        throw new Error(options.invalidMessage);
    }
    return candidate;
}

export function parseQueueComponent(
    value: string | undefined,
    name: string,
    allowColon: boolean,
): string | undefined {
    if (value === undefined) return undefined;
    const candidate = value.trim();
    const pattern = allowColon ? /^[a-zA-Z0-9:_-]+$/ : /^[a-zA-Z0-9_-]+$/;
    if (
        candidate.length === 0 ||
        candidate.length > 128 ||
        (!allowColon && candidate.includes(":")) ||
        !pattern.test(candidate)
    ) {
        throw new Error(`${name} is invalid`);
    }
    return candidate;
}

export function optionalNonEmpty(
    value: string | undefined,
): string | undefined {
    const candidate = value?.trim();
    return candidate ? candidate : undefined;
}
