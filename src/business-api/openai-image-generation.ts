/** OpenAI 图片生成/编辑 Adapter：封装 Images API 的 generate/edit 调用、栅格格式探测与用量解析 */
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
    signal?: AbortSignal;
};

type SourceImage = {
    bytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    filename?: string;
};

export type EditImageRequest = GenerateImageRequest &
    (
        | { image: SourceImage; imageUrl?: never }
        | { imageUrl: string; image?: never }
    );

export type OpenAIImageGenerationClientOptions = {
    apiKey: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetch?: typeof globalThis.fetch;
};

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
        if (!("image" in request) || request.image === undefined) {
            throw new Error(
                "The OpenAI image Adapter requires source image bytes",
            );
        }
        if (request.image.bytes.byteLength === 0) {
            throw new Error("GPT image edit requires source image bytes");
        }

        const model = request.model?.trim() || "gpt-image-2";
        const outputFormat = request.outputFormat ?? "png";
        const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
        const signal = request.signal
            ? AbortSignal.any([request.signal, timeoutSignal])
            : timeoutSignal;
        const sourceBytes = Uint8Array.from(request.image.bytes);
        const form = new FormData();
        form.set("model", model);
        form.append(
            "image[]",
            new Blob([sourceBytes], { type: request.image.mimeType }),
            request.image.filename?.trim() ||
                `source.${extensionFor(request.image.mimeType)}`,
        );
        form.set("prompt", prompt);
        form.set("n", "1");
        form.set("size", request.size ?? "1600x1200");
        form.set("quality", request.quality ?? "low");
        form.set("output_format", outputFormat);

        let response: Response;
        try {
            response = await this.#fetch(`${this.#baseUrl}/images/edits`, {
                method: "POST",
                headers: { authorization: `Bearer ${this.#apiKey}` },
                body: form,
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
