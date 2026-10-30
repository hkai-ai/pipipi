/** 封装 OpenAI 图片生成、参考图内存读取与文件表单编辑，以及结果和用量解析。 */
import type { ImageBackground } from "../processes/image-background.js";

export type GptImageQuality = "low" | "medium" | "high" | "auto";

export type GptImageOutputFormat = "png" | "jpeg" | "webp";

export type GptImageUsage = {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    textTokens?: number;
    imageTokens?: number;
};

export type GeneratedImage = {
    bytes: Buffer;
    mimeType: string;
    outputFormat: GptImageOutputFormat;
    width?: number;
    height?: number;
    requestId?: string;
    revisedPrompt?: string;
    usage?: GptImageUsage;
};

export type GenerateImageRequest = {
    prompt: string;
    model?: string;
    size?: string;
    quality?: GptImageQuality;
    outputFormat?: GptImageOutputFormat;
    background?: ImageBackground;
    signal?: AbortSignal;
};

type SourceImage = {
    bytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    filename?: string;
};

export type EditImageRequest = GenerateImageRequest & {
    idempotencyKey?: string;
} & (
        | { image: SourceImage; imageUrl?: never; imageUrls?: never }
        | { imageUrl: string; image?: never; imageUrls?: never }
        | { imageUrls: readonly string[]; image?: never; imageUrl?: never }
    );

export type OpenAIImageGenerationClientOptions = {
    apiKey: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetch?: typeof globalThis.fetch;
    referenceReader?: ReferenceImageReader;
    /** 省略沿用通用默认值；空对象表示由上游决定质量与输出格式。 */
    editDefaults?: {
        quality?: GptImageQuality;
        outputFormat?: GptImageOutputFormat;
    };
};

export type ReferenceImageReader = (
    url: string,
    signal: AbortSignal,
) => Promise<Response>;

export class OpenAIImageGenerationError extends Error {
    readonly status?: number;
    readonly requestId?: string;
    readonly code?: string;

    constructor(
        message: string,
        options: {
            status?: number;
            requestId?: string;
            code?: string;
            cause?: unknown;
        } = {},
    ) {
        super(
            message,
            options.cause === undefined ? {} : { cause: options.cause },
        );
        this.name = "OpenAIImageGenerationError";
        this.status = options.status;
        this.requestId = options.requestId;
        this.code = options.code;
    }
}

/** A narrow Adapter for the single-image Images API stage. */
export class OpenAIImageGenerationClient {
    readonly #apiKey: string;
    readonly #baseUrl: string;
    readonly #timeoutMs: number;
    readonly #fetch: typeof globalThis.fetch;
    readonly #referenceReader: ReferenceImageReader;
    readonly #editDefaults: NonNullable<
        OpenAIImageGenerationClientOptions["editDefaults"]
    >;

    constructor(options: OpenAIImageGenerationClientOptions) {
        const apiKey = options.apiKey.trim();
        if (!apiKey) throw new Error("OPENAI_API_KEY is required");

        const timeoutMs = options.timeoutMs ?? 180_000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
            throw new Error("GPT image timeout must be a positive integer");
        }

        this.#apiKey = apiKey;
        this.#baseUrl = (
            options.baseUrl?.trim() || "https://api.openai.com/v1"
        ).replace(/\/+$/, "");
        this.#timeoutMs = timeoutMs;
        this.#fetch = options.fetch ?? globalThis.fetch;
        this.#referenceReader =
            options.referenceReader ??
            ((url, signal) => this.#fetch(url, { signal, redirect: "error" }));
        this.#editDefaults = options.editDefaults ?? {
            quality: "low",
            outputFormat: "png",
        };
    }

    async generate(request: GenerateImageRequest): Promise<GeneratedImage> {
        const prompt = request.prompt.trim();
        if (!prompt) throw new Error("GPT image prompt is required");

        const model = request.model?.trim() || "gpt-image-2";
        const outputFormat = request.outputFormat ?? "png";
        const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
        const signal = request.signal
            ? AbortSignal.any([request.signal, timeoutSignal])
            : timeoutSignal;

        let response: Response;
        try {
            response = await this.#fetch(
                `${this.#baseUrl}/images/generations`,
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${this.#apiKey}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        model,
                        prompt,
                        n: 1,
                        size: request.size ?? "1024x1696",
                        quality: request.quality ?? "low",
                        output_format: outputFormat,
                        ...(request.background
                            ? { background: request.background }
                            : {}),
                    }),
                    signal,
                },
            );
        } catch (error) {
            throw new OpenAIImageGenerationError(
                "The GPT Image request did not reach a successful response",
                { cause: error },
            );
        }

        return readGeneratedImage(response);
    }

    async edit(request: EditImageRequest): Promise<GeneratedImage> {
        const prompt = request.prompt.trim();
        if (!prompt) throw new Error("GPT image prompt is required");
        const model = request.model?.trim() || "gpt-image-2";
        const outputFormat =
            request.outputFormat ?? this.#editDefaults.outputFormat;
        const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
        const signal = request.signal
            ? AbortSignal.any([request.signal, timeoutSignal])
            : timeoutSignal;
        const parameters = {
            model,
            prompt,
            n: 1,
            size: request.size ?? "1600x1200",
            quality: request.quality ?? this.#editDefaults.quality,
            output_format: outputFormat,
            ...(request.background ? { background: request.background } : {}),
        };
        const headers: Record<string, string> = {
            authorization: `Bearer ${this.#apiKey}`,
        };
        const images = request.imageUrls
            ? await readCharacterReferences(
                  request.imageUrls,
                  this.#referenceReader,
                  signal,
              )
            : request.image
              ? [request.image]
              : [];
        if (images.length === 0)
            throw new Error("GPT image edit requires source image data");
        const body = new FormData();
        for (const [key, value] of Object.entries(parameters)) {
            if (value !== undefined) body.set(key, String(value));
        }
        for (const [index, image] of images.entries()) {
            if (image.bytes.byteLength === 0) {
                throw new Error("GPT image edit requires source image bytes");
            }
            body.append(
                "image[]",
                new Blob([Uint8Array.from(image.bytes)], {
                    type: image.mimeType,
                }),
                image.filename?.trim() ||
                    `source-${index + 1}.${extensionFor(image.mimeType)}`,
            );
        }

        let response: Response;
        try {
            response = await this.#fetch(`${this.#baseUrl}/images/edits`, {
                method: "POST",
                headers,
                body,
                signal,
            });
        } catch (error) {
            throw new OpenAIImageGenerationError(
                "The GPT Image edit did not reach a successful response",
                { cause: error },
            );
        }

        return readGeneratedImage(response);
    }
}

function characterReferenceUrls(urls: readonly string[]): readonly string[] {
    if (urls.length < 1 || urls.length > 5) {
        throw new Error(
            "GPT image edit supports one to five character references",
        );
    }
    return urls.map((raw) => {
        const url = new URL(raw);
        if (
            url.protocol !== "https:" ||
            url.hostname !== "assets.memebuy.cn" ||
            url.username ||
            url.password ||
            url.port ||
            url.hash ||
            !(
                url.pathname.startsWith("/maker/characters/ai-fanworks/") ||
                url.pathname ===
                    "/maker/characters/community/scenes/doubao/chibi-5e7e8f7823faaa50.png"
            )
        ) {
            throw new Error("Character reference URL is not allowed");
        }
        return raw;
    });
}

async function readCharacterReferences(
    urls: readonly string[],
    readReference: ReferenceImageReader,
    callerSignal: AbortSignal,
): Promise<SourceImage[]> {
    const references = characterReferenceUrls(urls);
    const controller = new AbortController();
    const signal = AbortSignal.any([
        callerSignal,
        controller.signal,
        AbortSignal.timeout(15_000),
    ]);
    const maxBytes = 20 * 1024 * 1024;
    try {
        // 并行读取但保留原顺序；素材请求不携带网关凭证，也不跟随跳转。
        return await Promise.all(
            references.map(async (url) => {
                signal.throwIfAborted();
                const response = await readReference(url, signal);
                if (
                    !response.ok ||
                    !response.body ||
                    Number(response.headers.get("content-length")) > maxBytes
                ) {
                    await response.body?.cancel();
                    throw new Error("角色参考图读取失败或超过大小限制");
                }
                const reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let length = 0;
                try {
                    while (true) {
                        signal.throwIfAborted();
                        const { done, value } = await reader.read();
                        if (done) break;
                        length += value.byteLength;
                        if (length > maxBytes)
                            throw new Error("角色参考图超过大小限制");
                        chunks.push(value);
                    }
                } finally {
                    await reader.cancel();
                    reader.releaseLock();
                }
                const bytes = Buffer.concat(chunks, length);
                const detected = detectRasterImage(bytes);
                if (!detected) throw new Error("角色参考图不是支持的图片格式");
                const mimeType = {
                    png: "image/png",
                    jpeg: "image/jpeg",
                    webp: "image/webp",
                } as const;
                return { bytes, mimeType: mimeType[detected.outputFormat] };
            }),
        );
    } finally {
        // 任一读取失败时终止同批剩余请求。
        controller.abort();
    }
}

async function readGeneratedImage(response: Response): Promise<GeneratedImage> {
    const requestId = readRequestId(response.headers);
    const body = await readJson(response);
    if (!response.ok) {
        const apiError = readApiError(body);
        throw new OpenAIImageGenerationError(
            `GPT Image returned HTTP ${response.status}${apiError.message ? `: ${apiError.message}` : ""}`,
            {
                status: response.status,
                ...(requestId ? { requestId } : {}),
                ...(apiError.code ? { code: apiError.code } : {}),
            },
        );
    }

    const image = readFirstImage(body);
    const bytes = decodeBase64Image(image.b64Json);
    const detected = detectRasterImage(bytes);
    if (!detected) {
        throw new OpenAIImageGenerationError(
            "GPT Image returned data that is not a supported raster image",
            { ...(requestId ? { requestId } : {}) },
        );
    }

    return {
        bytes,
        mimeType: detected.mimeType,
        outputFormat: detected.outputFormat,
        ...(detected.width === undefined ? {} : { width: detected.width }),
        ...(detected.height === undefined ? {} : { height: detected.height }),
        ...(requestId ? { requestId } : {}),
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
        ...readUsage(body),
    };
}

function extensionFor(mimeType: SourceImage["mimeType"]): GptImageOutputFormat {
    if (mimeType === "image/jpeg") return "jpeg";
    if (mimeType === "image/webp") return "webp";
    return "png";
}

function readRequestId(headers: Headers): string | undefined {
    return (
        headers.get("x-request-id") ??
        headers.get("request-id") ??
        headers.get("openai-request-id") ??
        undefined
    );
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        throw new OpenAIImageGenerationError(
            `GPT Image returned invalid JSON with HTTP ${response.status}`,
            {
                status: response.status,
                ...(readRequestId(response.headers)
                    ? { requestId: readRequestId(response.headers) }
                    : {}),
            },
        );
    }
}

function readApiError(body: unknown): {
    code?: string;
    message?: string;
} {
    if (!isRecord(body) || !isRecord(body.error)) return {};
    const code =
        typeof body.error.code === "string" ? body.error.code : undefined;
    const message =
        typeof body.error.message === "string"
            ? body.error.message.slice(0, 500)
            : undefined;
    return {
        ...(code ? { code } : {}),
        ...(message ? { message } : {}),
    };
}

function readFirstImage(body: unknown): {
    b64Json: string;
    revisedPrompt?: string;
} {
    if (
        !isRecord(body) ||
        !Array.isArray(body.data) ||
        !isRecord(body.data[0]) ||
        typeof body.data[0].b64_json !== "string" ||
        !body.data[0].b64_json
    ) {
        throw new OpenAIImageGenerationError(
            "GPT Image returned no base64 image data",
        );
    }

    const revisedPrompt =
        typeof body.data[0].revised_prompt === "string"
            ? body.data[0].revised_prompt
            : undefined;
    return {
        b64Json: body.data[0].b64_json,
        ...(revisedPrompt ? { revisedPrompt } : {}),
    };
}

function decodeBase64Image(value: string): Buffer {
    const normalized = value.replace(/\s/g, "");
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
        throw new OpenAIImageGenerationError(
            "GPT Image returned malformed base64 image data",
        );
    }
    return Buffer.from(normalized, "base64");
}

export function detectRasterImage(bytes: Buffer):
    | {
          mimeType: string;
          outputFormat: GptImageOutputFormat;
          width?: number;
          height?: number;
      }
    | undefined {
    if (
        bytes.length >= 24 &&
        bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    ) {
        return {
            mimeType: "image/png",
            outputFormat: "png",
            width: bytes.readUInt32BE(16),
            height: bytes.readUInt32BE(20),
        };
    }
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return { mimeType: "image/jpeg", outputFormat: "jpeg" };
    }
    if (
        bytes.length >= 12 &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP"
    ) {
        return { mimeType: "image/webp", outputFormat: "webp" };
    }
    return undefined;
}

function readUsage(body: unknown): { usage?: GptImageUsage } {
    if (!isRecord(body) || !isRecord(body.usage)) return {};
    const details = isRecord(body.usage.input_tokens_details)
        ? body.usage.input_tokens_details
        : undefined;
    const usage: GptImageUsage = {
        ...readNumber(body.usage, "total_tokens", "totalTokens"),
        ...readNumber(body.usage, "input_tokens", "inputTokens"),
        ...readNumber(body.usage, "output_tokens", "outputTokens"),
        ...(details ? readNumber(details, "text_tokens", "textTokens") : {}),
        ...(details ? readNumber(details, "image_tokens", "imageTokens") : {}),
    };
    return Object.keys(usage).length === 0 ? {} : { usage };
}

function readNumber(
    source: Record<string, unknown>,
    sourceKey: string,
    targetKey: keyof GptImageUsage,
): GptImageUsage {
    const value = source[sourceKey];
    return typeof value === "number" && Number.isFinite(value)
        ? { [targetKey]: value }
        : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
