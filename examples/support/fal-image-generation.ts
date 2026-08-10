import { createFalClient } from "@fal-ai/client";
import {
    detectRasterImage,
    type EditImageRequest,
    type GeneratedImage,
    type GenerateImageRequest,
    type GptImageUsage,
} from "./openai-image-generation.js";

type FalImageSize =
    | "auto"
    | "square_hd"
    | "square"
    | "portrait_4_3"
    | "portrait_16_9"
    | "landscape_4_3"
    | "landscape_16_9"
    | Readonly<{ width: number; height: number }>;

export type FalSubscribe = (
    endpoint: string,
    options: Readonly<{
        input: Readonly<Record<string, unknown>>;
        abortSignal: AbortSignal;
    }>,
) => Promise<Readonly<{ data: unknown; requestId: string }>>;

export type FalImageGenerationClientOptions = {
    apiKey: string;
    timeoutMs?: number;
    subscribe?: FalSubscribe;
};

export class FalImageGenerationError extends Error {
    readonly status?: number;
    readonly requestId?: string;
    readonly code?: string;

    constructor(
        message: string,
        options: {
            status?: number;
            requestId?: string;
            code?: string;
        } = {},
    ) {
        super(message);
        this.name = "FalImageGenerationError";
        this.status = options.status;
        this.requestId = options.requestId;
        this.code = options.code;
    }
}

/** A narrow FAL Adapter for GPT Image 2 generation and single-image edits. */
export class FalImageGenerationClient {
    readonly #timeoutMs: number;
    readonly #subscribe: FalSubscribe;

    constructor(options: FalImageGenerationClientOptions) {
        const apiKey = options.apiKey.trim();
        if (!apiKey) throw new Error("FAL_KEY is required");

        const timeoutMs = options.timeoutMs ?? 180_000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
            throw new Error("FAL image timeout must be a positive integer");
        }

        this.#timeoutMs = timeoutMs;
        if (options.subscribe) {
            this.#subscribe = options.subscribe;
            return;
        }
        const client = createFalClient({
            credentials: apiKey,
            retry: { maxRetries: 0 },
        });
        this.#subscribe = async (endpoint, request) =>
            client.subscribe(endpoint, request);
    }

    async generate(request: GenerateImageRequest): Promise<GeneratedImage> {
        const prompt = request.prompt.trim();
        if (!prompt) throw new Error("FAL image prompt is required");
        requireGptImage2(request.model);

        const signal = timeoutSignal(request.signal, this.#timeoutMs);
        let result: Awaited<ReturnType<FalSubscribe>>;
        try {
            result = await this.#subscribe("openai/gpt-image-2", {
                input: {
                    prompt,
                    image_size: parseImageSize(request.size ?? "1024x1696"),
                    quality: request.quality ?? "low",
                    num_images: 1,
                    output_format: request.outputFormat ?? "png",
                    sync_mode: true,
                },
                abortSignal: signal,
            });
        } catch (error) {
            throw falRequestError("generation", error);
        }

        return readGeneratedImage(result);
    }

    async edit(request: EditImageRequest): Promise<GeneratedImage> {
        const prompt = request.prompt.trim();
        if (!prompt) throw new Error("FAL image prompt is required");
        if (request.image.bytes.byteLength === 0) {
            throw new Error("FAL image edit requires source image bytes");
        }
        requireGptImage2(request.model);

        const signal = timeoutSignal(request.signal, this.#timeoutMs);
        let result: Awaited<ReturnType<FalSubscribe>>;
        try {
            result = await this.#subscribe("openai/gpt-image-2/edit", {
                input: {
                    prompt,
                    image_urls: [
                        dataUri(request.image.bytes, request.image.mimeType),
                    ],
                    image_size: parseImageSize(request.size ?? "1600x1200"),
                    quality: request.quality ?? "low",
                    num_images: 1,
                    output_format: request.outputFormat ?? "png",
                    sync_mode: true,
                },
                abortSignal: signal,
            });
        } catch (error) {
            throw falRequestError("edit", error);
        }

        return readGeneratedImage(result);
    }
}

function requireGptImage2(value: string | undefined): void {
    const model = value?.trim() || "gpt-image-2";
    if (model !== "gpt-image-2") {
        throw new Error("The FAL image Adapter supports only gpt-image-2");
    }
}

function timeoutSignal(
    signal: AbortSignal | undefined,
    timeoutMs: number,
): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseImageSize(value: string): FalImageSize {
    const normalized = value.trim();
    if (isImageSizePreset(normalized)) return normalized;

    const match = /^(\d+)x(\d+)$/u.exec(normalized);
    if (!match) {
        throw new Error(
            "FAL image size must be a supported preset or WIDTHxHEIGHT",
        );
    }
    const width = Number(match[1]);
    const height = Number(match[2]);
    const pixels = width * height;
    const ratio = Math.max(width / height, height / width);
    if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width % 16 !== 0 ||
        height % 16 !== 0 ||
        width > 3840 ||
        height > 3840 ||
        pixels < 655_360 ||
        pixels > 8_294_400 ||
        ratio > 3
    ) {
        throw new Error("FAL image size is outside GPT Image 2 bounds");
    }
    return Object.freeze({ width, height });
}

function isImageSizePreset(
    value: string,
): value is Exclude<FalImageSize, Readonly<{ width: number; height: number }>> {
    return [
        "auto",
        "square_hd",
        "square",
        "portrait_4_3",
        "portrait_16_9",
        "landscape_4_3",
        "landscape_16_9",
    ].includes(value);
}

function dataUri(
    bytes: Uint8Array,
    mimeType: EditImageRequest["image"]["mimeType"],
): string {
    return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function readGeneratedImage(
    result: Awaited<ReturnType<FalSubscribe>>,
): GeneratedImage {
    const requestId = safeString(result.requestId);
    const image =
        isRecord(result.data) && Array.isArray(result.data.images)
            ? result.data.images[0]
            : undefined;
    if (!isRecord(image) || typeof image.url !== "string") {
        throw new FalImageGenerationError(
            "FAL returned no generated image data",
            requestId ? { requestId } : {},
        );
    }

    const bytes = decodeDataUri(image.url, requestId);
    const detected = detectRasterImage(bytes);
    if (!detected) {
        throw new FalImageGenerationError(
            "FAL returned data that is not a supported raster image",
            requestId ? { requestId } : {},
        );
    }
    const width = detected.width ?? positiveInteger(image.width);
    const height = detected.height ?? positiveInteger(image.height);

    return {
        bytes,
        mimeType: detected.mimeType,
        outputFormat: detected.outputFormat,
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(requestId ? { requestId } : {}),
        ...(isRecord(result.data) ? readUsage(result.data) : {}),
    };
}

function decodeDataUri(value: string, requestId: string | undefined): Buffer {
    const match =
        /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(
            value.replace(/\s/gu, ""),
        );
    if (!match?.[1]) {
        throw new FalImageGenerationError(
            "FAL did not return inline base64 image data",
            requestId ? { requestId } : {},
        );
    }
    return Buffer.from(match[1], "base64");
}

function readUsage(body: Record<string, unknown>): { usage?: GptImageUsage } {
    if (!isRecord(body.usage)) return {};
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

function falRequestError(
    operation: "generation" | "edit",
    error: unknown,
): FalImageGenerationError {
    if (error instanceof FalImageGenerationError) return error;
    const metadata = isRecord(error)
        ? {
              ...readStatus(error),
              ...readSafeString(error, "requestId", "requestId"),
              ...readSafeString(error, "code", "code"),
          }
        : {};
    return new FalImageGenerationError(
        `The FAL image ${operation} did not complete successfully`,
        metadata,
    );
}

function readStatus(error: Record<string, unknown>): { status?: number } {
    const value = error.status ?? error.statusCode;
    return typeof value === "number" && Number.isInteger(value)
        ? { status: value }
        : {};
}

function readSafeString<Target extends "requestId" | "code">(
    source: Record<string, unknown>,
    sourceKey: string,
    targetKey: Target,
): Partial<Record<Target, string>> {
    const value = safeString(source[sourceKey]);
    return value ? ({ [targetKey]: value } as Record<Target, string>) : {};
}

function safeString(value: unknown): string | undefined {
    return typeof value === "string" &&
        value.length <= 200 &&
        /^[A-Za-z0-9._:-]+$/u.test(value)
        ? value
        : undefined;
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
