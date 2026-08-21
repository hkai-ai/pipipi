/** 三个新闻图片 Process 的真实 HTTP/OSS 验收、下载限制、PNG 检查和无 URL 证据投影 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { NewsImageStyle } from "../processes/news-image/capability.js";

const maximumJsonBytes = 262_144;
const maximumImageBytes = 25 * 1024 * 1024;

const acceptanceCases = Object.freeze([
    Object.freeze({
        process: "news-image-narrative-monument",
        style: "narrative-monument",
    }),
    Object.freeze({
        process: "news-image-pale-watercolor",
        style: "pale-watercolor",
    }),
    Object.freeze({
        process: "news-image-raw-humanism",
        style: "raw-humanism",
    }),
] as const);

export type NewsImageAcceptanceRun = Readonly<{
    process: Readonly<{ id: string; version: "v1" }>;
    runId: string;
    processRunStatus: "succeeded";
    style: NewsImageStyle;
    object: Readonly<{
        contentType: "image/png";
        width: 1_600;
        height: 1_200;
        bytes: number;
        contentSha256: string;
        expectedOssLocationVerified: true;
        accessible: true;
    }>;
}>;

export type NewsImageAcceptanceResult = Readonly<{
    processRuns: readonly NewsImageAcceptanceRun[];
}>;

export function createNewsImageAcceptance(options: {
    baseUrl: string;
    expectedOssHost: string;
    expectedOssPathPrefix: string;
    timeoutMs: number;
    fetch?: typeof fetch;
}): Readonly<{ run: () => Promise<NewsImageAcceptanceResult> }> {
    const baseUrl = parseServiceBaseUrl(options.baseUrl);
    const expectedOssHost = parseExpectedHost(options.expectedOssHost);
    const expectedOssPathPrefix = parseExpectedPathPrefix(
        options.expectedOssPathPrefix,
    );
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
        throw new Error("News image acceptance timeout is invalid");
    }
    const fetchImplementation = options.fetch ?? fetch;

    return Object.freeze({
        run: async () => {
            const processRuns: NewsImageAcceptanceRun[] = [];
            for (const testCase of acceptanceCases) {
                processRuns.push(
                    await runCase({
                        ...testCase,
                        baseUrl,
                        expectedOssHost,
                        expectedOssPathPrefix,
                        timeoutMs: options.timeoutMs,
                        fetchImplementation,
                    }),
                );
            }
            if (new Set(processRuns.map(({ runId }) => runId)).size !== 3) {
                throw new Error("News image acceptance run IDs are not unique");
            }
            return Object.freeze({ processRuns: Object.freeze(processRuns) });
        },
    });
}

async function runCase(options: {
    process: string;
    style: NewsImageStyle;
    baseUrl: URL;
    expectedOssHost: string;
    expectedOssPathPrefix: string;
    timeoutMs: number;
    fetchImplementation: typeof fetch;
}): Promise<NewsImageAcceptanceRun> {
    const response = await options.fetchImplementation(
        new URL("/execute", options.baseUrl),
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                process: options.process,
                version: "v1",
                input: {
                    title: "城市公共空间更新计划进入实施阶段",
                    summary:
                        "项目将分阶段改善步行空间，并保留原有社区活动区域。",
                },
            }),
            redirect: "error",
            signal: AbortSignal.timeout(options.timeoutMs),
        },
    );
    const body = await readJson(response);
    const output = parseSuccessfulExecution(
        response.status,
        body,
        options.process,
        options.style,
    );
    const imageUrl = parseExpectedImageUrl(
        output.image.url,
        options.expectedOssHost,
        `${options.expectedOssPathPrefix}${options.style}/${output.runId}.png`,
    );
    const imageResponse = await options.fetchImplementation(imageUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (imageResponse.status < 200 || imageResponse.status >= 300) {
        throw new Error("News image acceptance object is not accessible");
    }
    const contentType = imageResponse.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
    if (contentType !== "image/png") {
        throw new Error("News image acceptance object is not PNG");
    }
    const declaredLength = Number(
        imageResponse.headers.get("content-length") ?? 0,
    );
    if (Number.isFinite(declaredLength) && declaredLength > maximumImageBytes) {
        throw new Error("News image acceptance object is too large");
    }
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    if (bytes.length < 1 || bytes.length > maximumImageBytes) {
        throw new Error("News image acceptance object size is invalid");
    }
    const metadata = await sharp(bytes).metadata();
    if (
        metadata.format !== "png" ||
        metadata.width !== 1_600 ||
        metadata.height !== 1_200
    ) {
        throw new Error("News image acceptance raster is invalid");
    }

    return Object.freeze({
        process: Object.freeze({ id: options.process, version: "v1" }),
        runId: output.runId,
        processRunStatus: "succeeded",
        style: options.style,
        object: Object.freeze({
            contentType: "image/png",
            width: 1_600,
            height: 1_200,
            bytes: bytes.length,
            contentSha256: createHash("sha256").update(bytes).digest("hex"),
            expectedOssLocationVerified: true,
            accessible: true,
        }),
    });
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (Buffer.byteLength(text) > maximumJsonBytes) {
        throw new Error("News image acceptance response is too large");
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error("News image acceptance response is not JSON");
    }
}

function parseSuccessfulExecution(
    status: number,
    value: unknown,
    process: string,
    style: NewsImageStyle,
): Readonly<{ runId: string; image: Readonly<{ url: string }> }> {
    if (
        status !== 200 ||
        !isRecord(value) ||
        !hasExactKeys(value, [
            "output",
            "process",
            "runId",
            "status",
            "version",
        ]) ||
        value.process !== process ||
        value.version !== "v1" ||
        value.status !== "succeeded" ||
        typeof value.runId !== "string" ||
        !/^[0-9a-f-]{36}$/u.test(value.runId) ||
        !isRecord(value.output) ||
        !hasExactKeys(value.output, ["image", "style"]) ||
        value.output.style !== style ||
        !isRecord(value.output.image) ||
        !hasOnlyImageKeys(value.output.image) ||
        typeof value.output.image.url !== "string" ||
        value.output.image.contentType !== "image/png" ||
        value.output.image.width !== 1_600 ||
        value.output.image.height !== 1_200
    ) {
        throw new Error("News image acceptance Process result is invalid");
    }
    return Object.freeze({
        runId: value.runId,
        image: Object.freeze({ url: value.output.image.url }),
    });
}

function hasOnlyImageKeys(value: Record<string, unknown>): boolean {
    const keys = Object.keys(value).sort();
    const withoutExpiry = ["contentType", "height", "url", "width"];
    const withExpiry = [...withoutExpiry, "expiresAt"].sort();
    const expected = keys.includes("expiresAt") ? withExpiry : withoutExpiry;
    if (!keys.every((key, index) => key === expected[index])) return false;
    if (keys.length !== expected.length) return false;
    return (
        value.expiresAt === undefined ||
        (typeof value.expiresAt === "string" &&
            Number.isFinite(Date.parse(value.expiresAt)))
    );
}

function parseExpectedImageUrl(
    value: string,
    expectedHost: string,
    expectedPath: string,
): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("News image acceptance object URL is invalid");
    }
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.host !== expectedHost ||
        url.pathname !== expectedPath
    ) {
        throw new Error("News image acceptance object location is invalid");
    }
    return url;
}

function parseServiceBaseUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("News image acceptance base URL is invalid");
    }
    if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        (url.protocol !== "https:" &&
            !(
                url.protocol === "http:" &&
                (url.hostname === "127.0.0.1" || url.hostname === "::1")
            ))
    ) {
        throw new Error("News image acceptance base URL is not allowed");
    }
    return url;
}

function parseExpectedHost(value: string): string {
    const host = value.trim().toLowerCase();
    if (!/^[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/u.test(host)) {
        throw new Error("News image acceptance OSS host is invalid");
    }
    return host;
}

function parseExpectedPathPrefix(value: string): string {
    const prefix = value.trim();
    if (
        !prefix.startsWith("/") ||
        !prefix.endsWith("/") ||
        prefix.includes("..") ||
        prefix.includes("?") ||
        prefix.includes("#") ||
        prefix.includes("//")
    ) {
        throw new Error("News image acceptance OSS path prefix is invalid");
    }
    return prefix;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function hasExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
): boolean {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return (
        actual.length === sortedExpected.length &&
        actual.every((key, index) => key === sortedExpected[index])
    );
}
