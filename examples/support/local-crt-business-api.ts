import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { basename, extname, join } from "node:path";
import sharp, { type Metadata } from "sharp";
import {
    type CrtAspectRatio,
    type CrtPalette,
    crtAspectRatios,
    crtPaletteNames,
} from "../../src/processes/crt/style.js";
import {
    type CrtEvidencePolicy,
    type CrtEvidenceResult,
    saveCrtEvidence,
} from "./crt-evidence.js";
import { crtImageDimensions, finalizeCrtImage } from "./crt-finalizer.js";
import { FalImageGenerationError } from "./fal-image-generation.js";
import {
    type EditImageRequest,
    type GeneratedImage,
    type GptImageQuality,
    OpenAIImageGenerationError,
} from "./openai-image-generation.js";

type ImageEditClient = Readonly<{
    edit: (request: EditImageRequest) => Promise<GeneratedImage>;
}>;

type Asset = Readonly<{
    id: string;
    path: string;
    filename: string;
    contentType: "image/png" | "image/jpeg" | "image/webp";
    bytes: number;
    width: number;
    height: number;
}>;

type CrtRequest = Readonly<{
    sourceImageId: string;
    prompt: string;
    palette: CrtPalette;
    aspectRatio: CrtAspectRatio;
}>;

type CrtImage = Readonly<{
    url: string;
    contentType: "image/png";
    width: number;
    height: number;
}>;

export type LocalCrtBusinessApiEvidence = Readonly<{
    storage: "local-filesystem";
    uploads: number;
    requests: number;
    editAttempts: number;
    edits: number;
    idempotencyKey?: string;
    sourceImageId?: string;
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

export type LocalCrtBusinessApi = Readonly<{
    url: string;
    evidence: () => LocalCrtBusinessApiEvidence;
    close: () => Promise<void>;
}>;

type PendingTransform = Readonly<{
    digest: string;
    result: Promise<CrtImage>;
}>;

const maximumSourceBytes = 50 * 1024 * 1024;
const maximumSourcePixels = 40_000_000;

export async function startLocalCrtBusinessApi(options: {
    directory: string;
    imageClient: ImageEditClient;
    provider?: string;
    model?: string;
    quality?: GptImageQuality;
    evidencePolicy?: CrtEvidencePolicy;
}): Promise<LocalCrtBusinessApi> {
    const directory = options.directory;
    const assetDirectory = join(directory, "assets");
    const outputDirectory = join(directory, "images");
    await Promise.all([
        mkdir(assetDirectory, { recursive: true }),
        mkdir(outputDirectory, { recursive: true }),
    ]);

    const provider = options.provider?.trim() || "openai";
    const model = options.model?.trim() || "gpt-image-2";
    const quality = options.quality ?? "low";
    const evidencePolicy = options.evidencePolicy ?? { mode: "off" };
    const assets = new Map<string, Asset>();
    const outputs = new Map<string, string>();
    const transforms = new Map<string, PendingTransform>();
    let serviceUrl = "";
    let uploads = 0;
    let requests = 0;
    let editAttempts = 0;
    let edits = 0;
    let idempotencyKey: string | undefined;
    let sourceImageId: string | undefined;
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
        if (request.method === "POST" && request.url === "/assets") {
            await uploadAsset(request, response);
            return;
        }
        if (request.method === "POST" && request.url === "/crt-images") {
            await transformAsset(request, response);
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
        response.writeHead(404).end();
    }

    async function uploadAsset(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const declaredType = parseImageContentType(
            singleHeader(request.headers["content-type"]),
        );
        const body = await readBody(request, maximumSourceBytes);
        const detectedType = detectImageContentType(body);
        if (!declaredType || detectedType !== declaredType) {
            writeJson(response, 415, {
                error: {
                    code: "UNSUPPORTED_MEDIA_TYPE",
                    message: "Upload must be a valid PNG, JPEG, or WebP image",
                },
            });
            return;
        }
        let metadata: Metadata;
        try {
            metadata = await sharp(body, {
                limitInputPixels: maximumSourcePixels,
            }).metadata();
        } catch {
            writeJson(response, 400, {
                error: {
                    code: "INVALID_IMAGE",
                    message: "Uploaded image could not be decoded",
                },
            });
            return;
        }
        const width = metadata.width;
        const height = metadata.height;
        if (
            !width ||
            !height ||
            width * height > maximumSourcePixels ||
            width > 12_000 ||
            height > 12_000
        ) {
            writeJson(response, 400, {
                error: {
                    code: "INVALID_IMAGE",
                    message: "Uploaded image dimensions are not supported",
                },
            });
            return;
        }
        const id = `asset_${randomUUID()}`;
        const requestedFilename = sanitizeFilename(
            singleHeader(request.headers["x-file-name"]),
            declaredType,
        );
        const path = join(
            assetDirectory,
            `${id}.${extensionFor(declaredType)}`,
        );
        await writeFile(path, body, { mode: 0o600 });
        const asset = Object.freeze({
            id,
            path,
            filename: requestedFilename,
            contentType: declaredType,
            bytes: body.length,
            width,
            height,
        });
        assets.set(id, asset);
        uploads += 1;
        sourceImageId = id;
        writeJson(response, 201, {
            sourceImageId: id,
            contentType: declaredType,
            bytes: body.length,
            width,
            height,
        });
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
        const asset = assets.get(input.sourceImageId);
        if (!asset) {
            writeJson(response, 404, {
                error: {
                    code: "ASSET_NOT_FOUND",
                    message: "Source image asset is unavailable",
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
        sourceImageId = input.sourceImageId;
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once("aborted", abort);
        let pending = existing?.result;
        if (!pending) {
            pending = performTransform(
                input,
                asset,
                requestKey,
                controller.signal,
            );
            transforms.set(
                requestKey,
                Object.freeze({ digest, result: pending }),
            );
        }
        try {
            writeJson(response, 200, await pending);
        } catch (error) {
            renderingFailure = summarizeRenderingFailure(error);
            writeJson(response, 503, {
                error: {
                    code: "CRT_RENDERING_UNAVAILABLE",
                    message: "CRT rendering is unavailable",
                },
            });
        } finally {
            request.off("aborted", abort);
        }
    }

    async function performTransform(
        input: CrtRequest,
        asset: Asset,
        requestKey: string,
        signal: AbortSignal,
    ): Promise<CrtImage> {
        const source = await readFile(asset.path);
        const target = crtImageDimensions(input.aspectRatio);
        renderingFailure = undefined;
        editAttempts += 1;
        const generated = await options.imageClient.edit({
            image: {
                bytes: source,
                mimeType: asset.contentType,
                filename: asset.filename,
            },
            prompt: input.prompt,
            model,
            size: `${target.width}x${target.height}`,
            quality,
            outputFormat: "png",
            signal,
        });
        edits += 1;
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
            source,
            palette: input.palette,
            aspectRatio: input.aspectRatio,
        });
        artifacts = await saveCrtEvidence(evidencePolicy, {
            runId: requestKey,
            createdAt: new Date().toISOString(),
            provider,
            model,
            quality,
            palette: input.palette,
            aspectRatio: input.aspectRatio,
            source: {
                bytes: source,
                contentType: asset.contentType,
                width: asset.width,
                height: asset.height,
            },
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
        return Object.freeze({
            url: `${serviceUrl}/images/${requestKey}.png`,
            contentType: "image/png",
            width: finalized.width,
            height: finalized.height,
        });
    }

    async function serveImage(
        key: string,
        response: ServerResponse,
    ): Promise<void> {
        const path = outputs.get(key);
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

    serviceUrl = await listenServer(server);
    return Object.freeze({
        url: serviceUrl,
        evidence: () =>
            Object.freeze({
                storage: "local-filesystem" as const,
                uploads,
                requests,
                editAttempts,
                edits,
                ...(idempotencyKey ? { idempotencyKey } : {}),
                ...(sourceImageId ? { sourceImageId } : {}),
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
    if (!isRecord(value) || Object.keys(value).length !== 4) {
        throw new Error("CRT request must be an object with four fields");
    }
    if (
        typeof value.sourceImageId !== "string" ||
        !/^asset_[a-f0-9-]+$/u.test(value.sourceImageId) ||
        typeof value.prompt !== "string" ||
        value.prompt.trim().length === 0 ||
        value.prompt.length > 50_000 ||
        typeof value.palette !== "string" ||
        !crtPaletteNames.includes(value.palette as CrtPalette) ||
        typeof value.aspectRatio !== "string" ||
        !crtAspectRatios.includes(value.aspectRatio as CrtAspectRatio)
    ) {
        throw new Error("CRT request is invalid");
    }
    return Object.freeze({
        sourceImageId: value.sourceImageId,
        prompt: value.prompt,
        palette: value.palette as CrtPalette,
        aspectRatio: value.aspectRatio as CrtAspectRatio,
    });
}

function parseIdempotencyKey(value: string | undefined): string {
    if (!value || value.length > 200 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
        throw new Error("CRT idempotency key is invalid");
    }
    return value;
}

function parseImageContentType(
    value: string | undefined,
): Asset["contentType"] | undefined {
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

function detectImageContentType(
    bytes: Buffer,
): Asset["contentType"] | undefined {
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

function sanitizeFilename(
    value: string | undefined,
    contentType: Asset["contentType"],
): string {
    const fallback = `source.${extensionFor(contentType)}`;
    if (!value) return fallback;
    const candidate = basename(value.trim()).replace(/[^A-Za-z0-9._-]/gu, "_");
    if (!candidate || candidate.length > 160 || !extname(candidate)) {
        return fallback;
    }
    return candidate;
}

function extensionFor(contentType: Asset["contentType"]): string {
    if (contentType === "image/jpeg") return "jpg";
    if (contentType === "image/webp") return "webp";
    return "png";
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

async function listenServer(server: Server): Promise<string> {
    await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolveListen();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        await closeServer(server);
        throw new Error("Local CRT Business API did not bind an IP address");
    }
    return `http://127.0.0.1:${address.port}`;
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
