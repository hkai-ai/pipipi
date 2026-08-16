import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { join } from "node:path";
import sharp from "sharp";
import {
    type CrtRenderingResult,
    isPublicSourceImageUrl,
    parseCrtRenderingResult,
} from "../processes/crt/capability.js";
import {
    type CrtAspectRatio,
    type CrtGrain,
    type CrtPalette,
    crtAspectRatios,
    crtGrains,
    crtPaletteNames,
} from "../processes/crt/style.js";
import {
    type NewsImageGeneration,
    type NewsImageRenderingResult,
    parseNewsImage,
    parseNewsImageRenderingResult,
} from "../processes/news-image/capability.js";
import {
    type CrtEvidencePolicy,
    type CrtEvidenceResult,
    saveCrtEvidence,
} from "./crt-evidence.js";
import { crtImageDimensions, finalizeCrtImage } from "./crt-finalizer.js";
import { FalImageGenerationError } from "./fal-image-generation.js";
import type { ObjectStorageCapability } from "./object-storage.js";
import {
    type EditImageRequest,
    type GeneratedImage,
    type GenerateImageRequest,
    type GptImageQuality,
    OpenAIImageGenerationError,
} from "./openai-image-generation.js";

type ImageEditClient = Readonly<{
    edit: (request: EditImageRequest) => Promise<GeneratedImage>;
}>;

type ImageGenerationClient = Readonly<{
    generate: (request: GenerateImageRequest) => Promise<GeneratedImage>;
}>;

type RasterContentType = "image/png" | "image/jpeg" | "image/webp";

type CrtRequest = Readonly<{
    sourceImageUrl: string;
    prompt: string;
    palette: CrtPalette;
    aspectRatio: CrtAspectRatio;
    grain: CrtGrain;
}>;

type NewsImageRequest = Readonly<{
    prompt: string;
    aspectRatio: "4:3";
    style: "narrative-monument" | "pale-watercolor" | "raw-humanism";
}>;

export type LocalCrtBusinessApiEvidence = Readonly<{
    storage: string;
    requests: number;
    editAttempts: number;
    edits: number;
    idempotencyKey?: string;
    sourceImageUrlSha256?: string;
    outputFile?: string;
    outputSha256?: string;
    colors?: readonly string[];
    blockSize?: number;
    imageRequestId?: string;
    artifacts: CrtEvidenceResult;
    renderingFailure?: Readonly<{
        name: string;
        message: string;
        status?: number;
        code?: string;
    }>;
}>;

export type CrtBusinessApi = Readonly<{
    url: string;
    evidence: () => LocalCrtBusinessApiEvidence;
    close: () => Promise<void>;
}>;

export type LocalCrtBusinessApi = CrtBusinessApi;

type PendingTransform<Result> = Readonly<{
    digest: string;
    result: Promise<Result>;
}>;

export async function startCrtBusinessApi(
    options: {
        directory: string;
        imageClient: ImageEditClient;
        generationClient?: ImageGenerationClient;
        provider?: string;
        model?: string;
        quality?: GptImageQuality;
        evidencePolicy?: CrtEvidencePolicy;
        storage?: ObjectStorageCapability;
        objectPrefix?: string;
    },
    listenOptions: { host?: string; port?: number } = {},
): Promise<CrtBusinessApi> {
    const directory = options.directory;
    const outputDirectory = join(directory, "images");
    const resultDirectory = join(directory, "results");
    const rawDirectory = join(directory, "raw-images");
    const newsOutputDirectory = join(directory, "news-images");
    const newsResultDirectory = join(directory, "news-results");
    await Promise.all([
        mkdir(outputDirectory, { recursive: true }),
        mkdir(resultDirectory, { recursive: true }),
        mkdir(rawDirectory, { recursive: true }),
        mkdir(newsOutputDirectory, { recursive: true }),
        mkdir(newsResultDirectory, { recursive: true }),
    ]);

    const provider = options.provider?.trim() || "openai";
    const model = options.model?.trim() || "gpt-image-2";
    const quality = options.quality ?? "low";
    const evidencePolicy = options.evidencePolicy ?? { mode: "off" };
    const objectPrefix = normalizeObjectPrefix(options.objectPrefix);
    const outputs = new Map<string, string>();
    const rawOutputs = new Map<string, string>();
    const newsOutputs = new Map<string, string>();
    const transforms = new Map<string, PendingTransform<CrtRenderingResult>>();
    const newsTransforms = new Map<
        string,
        PendingTransform<NewsImageRenderingResult>
    >();
    let serviceUrl = "";
    let requests = 0;
    let editAttempts = 0;
    let edits = 0;
    let idempotencyKey: string | undefined;
    let sourceImageUrlSha256: string | undefined;
    let outputFile: string | undefined;
    let outputSha256: string | undefined;
    let colors: readonly string[] | undefined;
    let blockSize: number | undefined;
    let imageRequestId: string | undefined;
    let artifacts: CrtEvidenceResult = Object.freeze({ mode: "off" });
    let renderingFailure:
        | NonNullable<LocalCrtBusinessApiEvidence["renderingFailure"]>
        | undefined;

    const server = createServer((request, response) => {
        void route(request, response).catch(() => {
            if (response.headersSent) {
                response.destroy();
                return;
            }
            writeJson(response, 500, {
                error: {
                    code: "INTERNAL_ERROR",
                    message: "The local CRT Business API failed",
                },
            });
        });
    });

    async function route(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        if (
            request.method === "GET" &&
            (request.url === "/healthz" || request.url === "/readyz")
        ) {
            writeJson(response, 200, { status: "ok" });
            return;
        }
        if (request.method === "POST" && request.url === "/crt-images") {
            await transformAsset(request, response);
            return;
        }
        if (request.method === "POST" && request.url === "/news-images") {
            await generateNewsAsset(request, response);
            return;
        }
        const imageMatch =
            request.method === "GET"
                ? /^\/images\/([A-Za-z0-9_-]+)\.png$/u.exec(request.url ?? "")
                : null;
        if (imageMatch) {
            await serveImage(imageMatch[1], response);
            return;
        }
        const rawImageMatch =
            request.method === "GET"
                ? /^\/raw-images\/([A-Za-z0-9_-]+)\.(png|jpg|webp)$/u.exec(
                      request.url ?? "",
                  )
                : null;
        if (rawImageMatch) {
            await serveRawImage(rawImageMatch[1], response);
            return;
        }
        const newsImageMatch =
            request.method === "GET"
                ? /^\/news-images\/([A-Za-z0-9_-]+)\.png$/u.exec(
                      request.url ?? "",
                  )
                : null;
        if (newsImageMatch) {
            await serveStoredImage(newsOutputs, newsImageMatch[1], response);
            return;
        }
        response.writeHead(404).end();
    }

    async function transformAsset(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        requests += 1;
        let input: CrtRequest;
        let requestKey: string;
        try {
            input = parseCrtRequest(
                JSON.parse((await readBody(request, 65_536)).toString("utf8")),
            );
            requestKey = parseIdempotencyKey(
                singleHeader(request.headers["idempotency-key"]),
            );
        } catch {
            writeJson(response, 400, {
                error: {
                    code: "INVALID_INPUT",
                    message: "CRT image request is invalid",
                },
            });
            return;
        }
        const digest = sha256(JSON.stringify(input));
        const existing = transforms.get(requestKey);
        if (existing && existing.digest !== digest) {
            writeJson(response, 409, {
                error: {
                    code: "IDEMPOTENCY_CONFLICT",
                    message:
                        "Idempotency key was already used for another request",
                },
            });
            return;
        }
        idempotencyKey = requestKey;
        sourceImageUrlSha256 = sha256(input.sourceImageUrl);
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once("aborted", abort);
        let pending = existing?.result;
        if (!pending) {
            const claim = await claimTransform(
                resultDirectory,
                requestKey,
                digest,
                parseCrtRenderingResult,
                "CRT",
            );
            if (claim.kind === "conflict") {
                writeJson(response, 409, {
                    error: {
                        code: "IDEMPOTENCY_CONFLICT",
                        message:
                            "Idempotency key was already used for another request",
                    },
                });
                request.off("aborted", abort);
                return;
            }
            if (claim.kind === "pending") {
                writeJson(response, 503, {
                    error: {
                        code: "CRT_RENDERING_UNAVAILABLE",
                        message: "CRT rendering status requires reconciliation",
                    },
                });
                request.off("aborted", abort);
                return;
            }
            if (claim.kind === "complete") {
                outputs.set(
                    requestKey,
                    join(outputDirectory, `${requestKey}.png`),
                );
                writeJson(response, 200, claim.result);
                request.off("aborted", abort);
                return;
            }
            pending = performTransform(
                input,
                requestKey,
                controller.signal,
            ).then(async (result) => {
                await completeTransform(
                    resultDirectory,
                    requestKey,
                    digest,
                    result,
                );
                return result;
            });
            transforms.set(
                requestKey,
                Object.freeze({ digest, result: pending }),
            );
        }
        try {
            writeJson(response, 200, await pending);
        } catch (error) {
            const committed = error instanceof CrtEditCommitted;
            renderingFailure = summarizeRenderingFailure(
                committed ? error.cause : error,
            );
            writeJson(
                response,
                503,
                committed
                    ? {
                          error: {
                              code: "CRT_RENDERING_INCOMPLETE",
                              message:
                                  "CRT rendering completed but the result could not be delivered",
                          },
                      }
                    : {
                          error: {
                              code: "CRT_RENDERING_UNAVAILABLE",
                              message: "CRT rendering is unavailable",
                          },
                      },
            );
        } finally {
            request.off("aborted", abort);
        }
    }

    async function generateNewsAsset(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        if (!options.generationClient) {
            writeJson(response, 503, {
                error: {
                    code: "NEWS_IMAGE_RENDERING_UNAVAILABLE",
                    message: "News image rendering is unavailable",
                },
            });
            return;
        }
        let input: NewsImageRequest;
        let requestKey: string;
        try {
            input = parseNewsImageRequest(
                JSON.parse((await readBody(request, 65_536)).toString("utf8")),
            );
            requestKey = parseIdempotencyKey(
                singleHeader(request.headers["idempotency-key"]),
            );
        } catch {
            writeJson(response, 400, {
                error: {
                    code: "INVALID_INPUT",
                    message: "News image request is invalid",
                },
            });
            return;
        }
        const digest = sha256(JSON.stringify(input));
        const existing = newsTransforms.get(requestKey);
        if (existing && existing.digest !== digest) {
            writeJson(response, 409, {
                error: {
                    code: "IDEMPOTENCY_CONFLICT",
                    message:
                        "Idempotency key was already used for another request",
                },
            });
            return;
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once("aborted", abort);
        let pending = existing?.result;
        if (!pending) {
            const claim = await claimTransform(
                newsResultDirectory,
                requestKey,
                digest,
                parseStoredNewsImageResult,
                "news image",
            );
            if (claim.kind === "conflict") {
                writeJson(response, 409, {
                    error: {
                        code: "IDEMPOTENCY_CONFLICT",
                        message:
                            "Idempotency key was already used for another request",
                    },
                });
                request.off("aborted", abort);
                return;
            }
            if (claim.kind === "pending") {
                writeJson(response, 503, {
                    error: {
                        code: "NEWS_IMAGE_RENDERING_UNAVAILABLE",
                        message:
                            "News image rendering status requires reconciliation",
                    },
                });
                request.off("aborted", abort);
                return;
            }
            if (claim.kind === "complete") {
                writeJson(response, 200, claim.result);
                request.off("aborted", abort);
                return;
            }
            pending = performNewsGeneration(
                input,
                requestKey,
                controller.signal,
            ).then(async (result) => {
                await completeTransform(
                    newsResultDirectory,
                    requestKey,
                    digest,
                    result,
                );
                return result;
            });
            newsTransforms.set(
                requestKey,
                Object.freeze({ digest, result: pending }),
            );
        }
        try {
            writeJson(response, 200, await pending);
        } catch {
            writeJson(response, 503, {
                error: {
                    code: "NEWS_IMAGE_RENDERING_UNAVAILABLE",
                    message: "News image rendering is unavailable",
                },
            });
        } finally {
            request.off("aborted", abort);
        }
    }

    async function performNewsGeneration(
        input: NewsImageRequest,
        requestKey: string,
        signal: AbortSignal,
    ): Promise<NewsImageRenderingResult> {
        if (!options.generationClient) {
            throw new Error("News image generation client is unavailable");
        }
        const generated = await options.generationClient.generate({
            prompt: input.prompt,
            model,
            size: "1600x1200",
            quality,
            outputFormat: "png",
            signal,
        });
        const raw = Buffer.from(generated.bytes);
        if (
            generated.mimeType !== "image/png" ||
            detectImageContentType(raw) !== "image/png"
        ) {
            throw new Error("GPT Image returned an unsupported news raster");
        }
        const finalized = await sharp(raw)
            .resize(1600, 1200, { fit: "cover", position: "centre" })
            .png()
            .toBuffer();
        const path = join(newsOutputDirectory, `${requestKey}.png`);
        await writeFile(path, finalized, { mode: 0o600 });
        newsOutputs.set(requestKey, path);
        const stored = options.storage
            ? await options.storage.upload(
                  {
                      objectKey: `news-image/${input.style}/${requestKey}.png`,
                      bytes: finalized,
                      contentType: "image/png",
                      cacheControl: "private, max-age=31536000, immutable",
                  },
                  { signal },
              )
            : undefined;
        return Object.freeze({
            image: Object.freeze({
                url:
                    stored?.url ??
                    `${serviceUrl}/news-images/${requestKey}.png`,
                contentType: "image/png" as const,
                width: 1_600 as const,
                height: 1_200 as const,
                ...(stored?.urlExpiresAt
                    ? { expiresAt: stored.urlExpiresAt }
                    : {}),
            }),
            generation: newsImageGeneration(),
        });
    }

    function parseStoredNewsImageResult(
        value: unknown,
    ): NewsImageRenderingResult {
        try {
            return parseNewsImageRenderingResult(value);
        } catch {
            return Object.freeze({
                image: parseNewsImage(value),
                generation: newsImageGeneration(),
            });
        }
    }

    function newsImageGeneration(): NewsImageGeneration {
        const otherParams: Record<string, string | number | boolean | null> =
            {};
        if (provider === "fal") otherParams.sync_mode = true;
        return Object.freeze({
            imageProvider: provider,
            imageModel: model,
            aspectRatio: "4:3",
            width: 1_600,
            height: 1_200,
            quality,
            outputFormat: "png",
            numImages: 1,
            seed: null,
            otherParams: Object.freeze(otherParams),
        });
    }

    async function performTransform(
        input: CrtRequest,
        requestKey: string,
        signal: AbortSignal,
    ): Promise<CrtRenderingResult> {
        const target = crtImageDimensions(input.aspectRatio);
        renderingFailure = undefined;
        editAttempts += 1;
        const generated = await options.imageClient.edit({
            imageUrl: input.sourceImageUrl,
            prompt: input.prompt,
            model,
            size: `${target.width}x${target.height}`,
            quality,
            outputFormat: "png",
            signal,
        });
        // The edit has returned, so the vendor has charged for it. Every
        // failure past this line is reported as committed even though the
        // caller never receives an image.
        edits += 1;
        try {
            return await deliverEditedImage(
                input,
                requestKey,
                signal,
                generated,
            );
        } catch (error) {
            throw new CrtEditCommitted(error);
        }
    }

    async function deliverEditedImage(
        input: CrtRequest,
        requestKey: string,
        signal: AbortSignal,
        generated: GeneratedImage,
    ): Promise<CrtRenderingResult> {
        const raw = Buffer.from(generated.bytes);
        const rawContentType = parseImageContentType(generated.mimeType);
        if (!rawContentType || detectImageContentType(raw) !== rawContentType) {
            throw new Error("GPT Image returned an unsupported raster");
        }
        const rawMetadata = await sharp(raw).metadata();
        if (!rawMetadata.width || !rawMetadata.height) {
            throw new Error("GPT Image returned a raster without dimensions");
        }
        const finalized = await finalizeCrtImage({
            generated: raw,
            palette: input.palette,
            aspectRatio: input.aspectRatio,
            grain: input.grain,
        });
        artifacts = await saveCrtEvidence(evidencePolicy, {
            runId: requestKey,
            createdAt: new Date().toISOString(),
            provider,
            model,
            quality,
            palette: input.palette,
            aspectRatio: input.aspectRatio,
            grain: input.grain,
            sourceUrlSha256: sha256(input.sourceImageUrl),
            raw: {
                bytes: raw,
                contentType: rawContentType,
                width: rawMetadata.width,
                height: rawMetadata.height,
                ...(generated.requestId
                    ? { requestId: generated.requestId }
                    : {}),
                ...(generated.usage ? { usage: generated.usage } : {}),
            },
            final: {
                bytes: finalized.bytes,
                contentType: "image/png",
                width: finalized.width,
                height: finalized.height,
                colors: finalized.colors,
                blockSize: finalized.blockSize,
            },
        });
        const path = join(outputDirectory, `${requestKey}.png`);
        await writeFile(path, finalized.bytes, { mode: 0o600 });
        outputs.set(requestKey, path);
        outputFile = path;
        outputSha256 = sha256(finalized.bytes);
        colors = finalized.colors;
        blockSize = finalized.blockSize;
        imageRequestId = generated.requestId;
        // `result/` and `raw/` are separate segments so the caller can attach a
        // different lifecycle rule to each: the delivered product and the model
        // output that lets them re-derive another grain without a new render.
        const stored = options.storage
            ? await options.storage.upload(
                  {
                      objectKey: `${objectPrefix}/result/${requestKey}.png`,
                      bytes: finalized.bytes,
                      contentType: "image/png",
                      cacheControl: "private, max-age=31536000, immutable",
                  },
                  { signal },
              )
            : undefined;
        const rawExtension = extensionForRaster(rawContentType);
        const rawPath = join(rawDirectory, `${requestKey}.${rawExtension}`);
        await writeFile(rawPath, raw, { mode: 0o600 });
        rawOutputs.set(requestKey, rawPath);
        const storedRaw = options.storage
            ? await options.storage.upload(
                  {
                      objectKey: `${objectPrefix}/raw/${requestKey}.${rawExtension}`,
                      bytes: raw,
                      contentType: rawContentType,
                      cacheControl: "private, max-age=31536000, immutable",
                  },
                  { signal },
              )
            : undefined;
        return Object.freeze({
            image: Object.freeze({
                url: stored?.url ?? `${serviceUrl}/images/${requestKey}.png`,
                contentType: "image/png" as const,
                width: finalized.width,
                height: finalized.height,
                ...(stored?.urlExpiresAt
                    ? { expiresAt: stored.urlExpiresAt }
                    : {}),
            }),
            rawImage: Object.freeze({
                url:
                    storedRaw?.url ??
                    `${serviceUrl}/raw-images/${requestKey}.${rawExtension}`,
                contentType: rawContentType,
                width: rawMetadata.width,
                height: rawMetadata.height,
                ...(storedRaw?.urlExpiresAt
                    ? { expiresAt: storedRaw.urlExpiresAt }
                    : {}),
            }),
        });
    }

    async function serveImage(
        key: string,
        response: ServerResponse,
    ): Promise<void> {
        await serveStoredImage(outputs, key, response);
    }

    async function serveRawImage(
        key: string,
        response: ServerResponse,
    ): Promise<void> {
        const path = rawOutputs.get(key);
        if (!path) {
            response.writeHead(404).end();
            return;
        }
        const bytes = await readFile(path);
        response.writeHead(200, {
            "content-type": contentTypeForExtension(path),
            "content-length": String(bytes.length),
            "cache-control": "no-store",
        });
        response.end(bytes);
    }

    async function serveStoredImage(
        files: ReadonlyMap<string, string>,
        key: string,
        response: ServerResponse,
    ): Promise<void> {
        const path = files.get(key);
        if (!path) {
            response.writeHead(404).end();
            return;
        }
        const bytes = await readFile(path);
        response.writeHead(200, {
            "content-type": "image/png",
            "content-length": String(bytes.length),
            "cache-control": "no-store",
        });
        response.end(bytes);
    }

    serviceUrl = await listenServer(server, listenOptions);
    return Object.freeze({
        url: serviceUrl,
        evidence: () =>
            Object.freeze({
                storage: options.storage?.provider ?? "local-filesystem",
                requests,
                editAttempts,
                edits,
                ...(idempotencyKey ? { idempotencyKey } : {}),
                ...(sourceImageUrlSha256 ? { sourceImageUrlSha256 } : {}),
                ...(outputFile ? { outputFile } : {}),
                ...(outputSha256 ? { outputSha256 } : {}),
                ...(colors ? { colors } : {}),
                ...(blockSize ? { blockSize } : {}),
                ...(imageRequestId ? { imageRequestId } : {}),
                artifacts,
                ...(renderingFailure ? { renderingFailure } : {}),
            }),
        close: () => closeServer(server),
    });
}

type TransformClaim<Result> =
    | Readonly<{ kind: "claimed" }>
    | Readonly<{ kind: "pending" }>
    | Readonly<{ kind: "conflict" }>
    | Readonly<{ kind: "complete"; result: Result }>;

async function claimTransform<Result>(
    directory: string,
    key: string,
    digest: string,
    parseResult: (value: unknown) => Result,
    label: string,
): Promise<TransformClaim<Result>> {
    const path = join(directory, `${key}.json`);
    try {
        await writeFile(path, JSON.stringify({ digest, state: "pending" }), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        return Object.freeze({ kind: "claimed" });
    } catch (error) {
        if (!isFileExistsError(error)) throw error;
    }

    const record = parseTransformRecord(
        JSON.parse(await readFile(path, "utf8")),
        parseResult,
        label,
    );
    if (record.digest !== digest) return Object.freeze({ kind: "conflict" });
    if (record.state === "pending") return Object.freeze({ kind: "pending" });
    return Object.freeze({ kind: "complete", result: record.result });
}

async function completeTransform<Result>(
    directory: string,
    key: string,
    digest: string,
    result: Result,
): Promise<void> {
    const path = join(directory, `${key}.json`);
    const temporaryPath = join(
        directory,
        `${key}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(
        temporaryPath,
        JSON.stringify({ digest, state: "complete", result }),
        { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, path);
}

function parseTransformRecord<Result>(
    value: unknown,
    parseResult: (value: unknown) => Result,
    label: string,
):
    | Readonly<{ digest: string; state: "pending" }>
    | Readonly<{ digest: string; state: "complete"; result: Result }> {
    if (!isRecord(value) || !/^[a-f0-9]{64}$/u.test(String(value.digest))) {
        throw new Error(`Stored ${label} idempotency record is invalid`);
    }
    const digest = String(value.digest);
    if (value.state === "pending")
        return Object.freeze({ digest, state: "pending" });
    if (value.state === "complete") {
        return Object.freeze({
            digest,
            state: "complete",
            result: parseResult(value.result),
        });
    }
    throw new Error(`Stored ${label} idempotency state is invalid`);
}

function isFileExistsError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
    );
}

export const startLocalCrtBusinessApi = startCrtBusinessApi;

/**
 * Marks a failure that happened after the image edit returned, meaning the
 * vendor has already charged for a render the caller will never receive. It
 * only carries the original failure so the existing summariser keeps producing
 * the same sanitised evidence.
 */
class CrtEditCommitted extends Error {
    override readonly cause: unknown;

    constructor(cause: unknown) {
        super("CRT rendering completed but delivery failed");
        this.name = "CrtEditCommitted";
        this.cause = cause;
    }
}

function summarizeRenderingFailure(
    error: unknown,
): NonNullable<LocalCrtBusinessApiEvidence["renderingFailure"]> {
    if (
        error instanceof OpenAIImageGenerationError ||
        error instanceof FalImageGenerationError
    ) {
        return Object.freeze({
            name: error.name,
            message: error.message.slice(0, 500),
            ...(error.status === undefined ? {} : { status: error.status }),
            ...(error.code === undefined ? {} : { code: error.code }),
        });
    }
    if (error instanceof Error) {
        return Object.freeze({
            name: error.name,
            message: error.message.slice(0, 500),
        });
    }
    return Object.freeze({
        name: "UnknownError",
        message: "The rendering dependency failed",
    });
}

function parseCrtRequest(value: unknown): CrtRequest {
    if (!isRecord(value) || Object.keys(value).length !== 5) {
        throw new Error("CRT request must be an object with five fields");
    }
    if (
        typeof value.sourceImageUrl !== "string" ||
        !isPublicSourceImageUrl(value.sourceImageUrl) ||
        typeof value.prompt !== "string" ||
        value.prompt.trim().length === 0 ||
        value.prompt.length > 50_000 ||
        typeof value.palette !== "string" ||
        !crtPaletteNames.includes(value.palette as CrtPalette) ||
        typeof value.aspectRatio !== "string" ||
        !crtAspectRatios.includes(value.aspectRatio as CrtAspectRatio) ||
        typeof value.grain !== "string" ||
        !crtGrains.includes(value.grain as CrtGrain)
    ) {
        throw new Error("CRT request is invalid");
    }
    return Object.freeze({
        sourceImageUrl: value.sourceImageUrl,
        prompt: value.prompt,
        palette: value.palette as CrtPalette,
        aspectRatio: value.aspectRatio as CrtAspectRatio,
        grain: value.grain as CrtGrain,
    });
}

function parseNewsImageRequest(value: unknown): NewsImageRequest {
    if (!isRecord(value)) throw new Error("News image body must be an object");
    const keys = Object.keys(value).sort();
    if (
        keys.length !== 3 ||
        keys[0] !== "aspectRatio" ||
        keys[1] !== "prompt" ||
        keys[2] !== "style"
    ) {
        throw new Error("News image body has unsupported fields");
    }
    if (
        typeof value.prompt !== "string" ||
        value.prompt !== value.prompt.trim() ||
        value.prompt.length < 300 ||
        value.prompt.length > 8_000 ||
        value.aspectRatio !== "4:3" ||
        (value.style !== "narrative-monument" &&
            value.style !== "pale-watercolor" &&
            value.style !== "raw-humanism")
    ) {
        throw new Error("News image body is invalid");
    }
    return Object.freeze({
        prompt: value.prompt,
        aspectRatio: "4:3",
        style: value.style,
    });
}

function parseIdempotencyKey(value: string | undefined): string {
    if (!value || value.length > 200 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
        throw new Error("CRT idempotency key is invalid");
    }
    return value;
}

function normalizeObjectPrefix(value: string | undefined): string {
    const prefix =
        value?.trim().replace(/^\/+|\/+$/gu, "") || "crt-interface-image";
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,199}$/u.test(prefix)) {
        throw new Error("CRT image object prefix is invalid");
    }
    return prefix;
}

function extensionForRaster(contentType: RasterContentType): string {
    if (contentType === "image/jpeg") return "jpg";
    if (contentType === "image/webp") return "webp";
    return "png";
}

function contentTypeForExtension(path: string): RasterContentType {
    if (path.endsWith(".jpg")) return "image/jpeg";
    if (path.endsWith(".webp")) return "image/webp";
    return "image/png";
}

function parseImageContentType(
    value: string | undefined,
): RasterContentType | undefined {
    const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
    if (
        normalized === "image/png" ||
        normalized === "image/jpeg" ||
        normalized === "image/webp"
    ) {
        return normalized;
    }
    return undefined;
}

function detectImageContentType(bytes: Buffer): RasterContentType | undefined {
    if (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    ) {
        return "image/png";
    }
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return "image/jpeg";
    }
    if (
        bytes.length >= 12 &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP"
    ) {
        return "image/webp";
    }
    return undefined;
}

async function readBody(
    request: IncomingMessage,
    maximumBytes: number,
): Promise<Buffer> {
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error("Request body is too large");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maximumBytes) throw new Error("Request body is too large");
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function singleHeader(
    value: string | string[] | undefined,
): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function writeJson(
    response: ServerResponse,
    status: number,
    value: unknown,
): void {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
    });
    response.end(body);
}

async function listenServer(
    server: Server,
    options: { host?: string; port?: number },
): Promise<string> {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolveListen();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        await closeServer(server);
        throw new Error("Local CRT Business API did not bind an IP address");
    }
    const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return `http://${urlHost}:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
    });
}

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
