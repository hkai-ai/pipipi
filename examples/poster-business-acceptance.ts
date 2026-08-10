import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { join, resolve } from "node:path";
import { parseOpenAIApiMode } from "../src/agent-runtime/pi.js";
import { constructProcessingService } from "../src/app/api.js";
import type { ProcessRunResult } from "../src/process-runtime/index.js";
import {
    type PosterImage,
    type PosterRenderingCapability,
    PosterRenderingUnavailable,
} from "../src/processes/poster/capability.js";
import { createImageGenerationClient } from "./support/image-generation-config.js";
import type { StoredObject } from "./support/object-storage.js";
import { createObjectStorageFromEnvironment } from "./support/object-storage-config.js";
import type {
    GeneratedImage,
    GptImageOutputFormat,
    GptImageQuality,
} from "./support/openai-image-generation.js";

const reportDirectory = resolve(
    process.env.GPT_IMAGE_REPORT_DIRECTORY ?? "artifacts/gpt-image-2",
);
const skillDirectory = resolve(
    process.env.GPT_IMAGE_SKILL_DIRECTORY ??
        ".pi/skills/minimal-zine-poster-prompt",
);
const brief =
    process.env.GPT_IMAGE_THEME?.trim() ||
    "Create a quiet minimal zine poster about a rainy used bookstore.";
const text = process.env.GPT_IMAGE_REQUIRED_TEXT?.trim() || "PIPIPI ZINE";
const provider = process.env.PI_PROVIDER ?? "openai";
const agentModel = process.env.PI_MODEL ?? "gpt-5.6-terra";
const imageModel = process.env.GPT_IMAGE_MODEL ?? "gpt-image-2";
const imageSize = process.env.GPT_IMAGE_SIZE ?? "1024x1696";
const imageQuality = parseQuality(process.env.GPT_IMAGE_QUALITY);
const imageOutputFormat = parseOutputFormat(
    process.env.GPT_IMAGE_OUTPUT_FORMAT,
);
const imageTimeoutMs = parsePositiveInteger(
    process.env.GPT_IMAGE_TIMEOUT_MS,
    180_000,
    "GPT_IMAGE_TIMEOUT_MS",
);
const agentTimeoutMs = parsePositiveInteger(
    process.env.GPT_IMAGE_AGENT_TIMEOUT_MS,
    120_000,
    "GPT_IMAGE_AGENT_TIMEOUT_MS",
);
const processTimeoutMs = parsePositiveInteger(
    process.env.GPT_IMAGE_PROCESS_TIMEOUT_MS,
    agentTimeoutMs + imageTimeoutMs + 10_000,
    "GPT_IMAGE_PROCESS_TIMEOUT_MS",
);
const imageObjectPrefix =
    process.env.GPT_IMAGE_OBJECT_PREFIX?.trim() || "minimal-zine-poster";
const objectStorage = createObjectStorageFromEnvironment(process.env);
const apiMode = parseOpenAIApiMode(process.env.OPENAI_API_MODE);
const skillFile = join(skillDirectory, "SKILL.md");
const skillSource = await readFile(skillFile, "utf8");

type PosterOutput = {
    prompt: string;
    recipe: {
        layout: string;
        anchor: string;
        typography: string;
        accent: string;
        texture: string;
        mood: string;
    };
    interpretation: string;
    image: PosterImage;
};

type Check = { criterion: string; passed: boolean };

type Report = {
    generatedAt: string;
    passed: boolean;
    transport: {
        request: "POST /execute";
        httpStatus: number;
        contentType: string | null;
    };
    capability: {
        request: "POST /posters";
        calls: number;
        idempotencyKeyMatchesRunId: boolean;
    };
    process: {
        id: "minimal-zine-poster";
        version: "v1";
        runId: string;
        status: ProcessRunResult["status"];
        error?: { code: string; message: string };
    };
    input: { brief: string; text: string };
    skill: {
        name: "minimal-zine-poster-prompt";
        directory: string;
        sha256: string;
        upstreamSha256: string;
    };
    agent: {
        provider: string;
        model: string;
        apiMode: string;
    };
    output?: PosterOutput;
    generatedImage?: {
        provider: string;
        model: string;
        requestedSize: string;
        quality: GptImageQuality;
        requestedOutputFormat: GptImageOutputFormat;
        file: string;
        bytes: number;
        sha256: string;
        requestId?: string;
        usage?: GeneratedImage["usage"];
    };
    storage?: {
        provider: string;
        bucket: string;
        objectKey: string;
        url: string;
        urlAccess: StoredObject["urlAccess"];
        urlExpiresAt?: string;
    };
    errors: { rendering?: string };
    checks: Check[];
};

let renderingError: string | undefined;
let generatedImage: GeneratedImage | undefined;
let generatedImageFile: string | undefined;
let storedObject: StoredObject | undefined;
let localImageServer: LocalImageServer | undefined;

const imageGeneration = createImageGenerationClient(process.env, {
    timeoutMs: imageTimeoutMs,
});
const imageClient = imageGeneration.client;
const rendering: PosterRenderingCapability = {
    render: async (input, options) => {
        try {
            generatedImage = await imageClient.generate({
                prompt: input.prompt,
                model: imageModel,
                size: imageSize,
                quality: imageQuality,
                outputFormat: imageOutputFormat,
                signal: options.signal,
            });
            const dimensions = imageDimensions(generatedImage, imageSize);
            await mkdir(reportDirectory, { recursive: true });
            generatedImageFile = join(
                reportDirectory,
                `latest.${generatedImage.outputFormat}`,
            );
            await writeFile(generatedImageFile, generatedImage.bytes);

            let imageUrl: string;
            let expiresAt: string | undefined;
            if (objectStorage) {
                storedObject = await objectStorage.upload(
                    {
                        objectKey: `${imageObjectPrefix}/${options.idempotencyKey}.${generatedImage.outputFormat}`,
                        bytes: generatedImage.bytes,
                        contentType: generatedImage.mimeType,
                    },
                    { signal: options.signal },
                );
                imageUrl = storedObject.url;
                expiresAt = storedObject.urlExpiresAt;
            } else {
                localImageServer = await startLocalImageServer(generatedImage);
                imageUrl = localImageServer.url;
            }

            return {
                url: imageUrl,
                contentType: posterContentType(generatedImage.mimeType),
                width: dimensions.width,
                height: dimensions.height,
                ...(expiresAt ? { expiresAt } : {}),
            };
        } catch (error) {
            renderingError = formatErrorChain(error);
            throw new PosterRenderingUnavailable({ cause: error });
        }
    },
};
const businessApi = await startPosterBusinessApi(rendering);
const { application } = constructProcessingService({
    ...process.env,
    BUSINESS_API_BASE_URL: businessApi.url,
    PI_PROVIDER: provider,
    PI_MODEL: agentModel,
    OPENAI_API_MODE: apiMode,
    PI_POSTER_SKILL_DIRECTORY: skillDirectory,
    POSTER_API_TIMEOUT_MS: String(imageTimeoutMs + 10_000),
    PROCESS_TIMEOUT_MS: String(processTimeoutMs),
});
const { url: serviceUrl } = await application.listen();

try {
    const response = await fetch(`${serviceUrl}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            process: "minimal-zine-poster",
            version: "v1",
            input: { brief, text },
        }),
        signal: AbortSignal.timeout(processTimeoutMs + 10_000),
    });
    const result = parseProcessResult(await response.json());

    const output = successfulPosterOutput(result);
    const downloadedImagePassed =
        output && generatedImage
            ? await imageUrlMatches(output.image.url, generatedImage.bytes)
            : undefined;
    const checks = evaluate({
        result,
        output,
        generatedImage,
        requiredText: text,
        storageExpected: objectStorage !== undefined,
        storedObject,
        downloadedImagePassed,
        httpStatus: response.status,
        capability: businessApi.evidence(),
    });
    const capabilityEvidence = businessApi.evidence();
    const report: Report = {
        generatedAt: new Date().toISOString(),
        passed: checks.every((check) => check.passed),
        transport: {
            request: "POST /execute",
            httpStatus: response.status,
            contentType: response.headers.get("content-type"),
        },
        capability: {
            request: "POST /posters",
            calls: capabilityEvidence.calls,
            idempotencyKeyMatchesRunId:
                capabilityEvidence.idempotencyKey === result.runId,
        },
        process: {
            id: "minimal-zine-poster",
            version: "v1",
            runId: result.runId,
            status: result.status,
            ...(result.status === "failed" ? { error: result.error } : {}),
        },
        input: { brief, text },
        skill: {
            name: "minimal-zine-poster-prompt",
            directory: skillDirectory,
            sha256: sha256(skillSource),
            upstreamSha256:
                "d4e1199623ee4d98e948189308eedc601f83ab0ae923568c6e9240f89c783b8b",
        },
        agent: {
            provider,
            model: agentModel,
            apiMode,
        },
        ...(output ? { output } : {}),
        ...(generatedImage && generatedImageFile
            ? {
                  generatedImage: {
                      provider: imageGeneration.provider,
                      model: imageModel,
                      requestedSize: imageSize,
                      quality: imageQuality,
                      requestedOutputFormat: imageOutputFormat,
                      file: generatedImageFile,
                      bytes: generatedImage.bytes.length,
                      sha256: sha256(generatedImage.bytes),
                      ...(generatedImage.requestId
                          ? { requestId: generatedImage.requestId }
                          : {}),
                      ...(generatedImage.usage
                          ? { usage: generatedImage.usage }
                          : {}),
                  },
              }
            : {}),
        ...(storedObject
            ? {
                  storage: {
                      provider: storedObject.provider,
                      bucket: storedObject.bucket,
                      objectKey: storedObject.objectKey,
                      url: storedObject.url,
                      urlAccess: storedObject.urlAccess,
                      ...(storedObject.urlExpiresAt
                          ? { urlExpiresAt: storedObject.urlExpiresAt }
                          : {}),
                  },
              }
            : {}),
        errors: {
            ...(renderingError ? { rendering: renderingError } : {}),
        },
        checks,
    };
    const reportFiles = await writeReport(report);

    console.log(
        JSON.stringify(
            {
                passed: report.passed,
                transport: report.transport,
                capability: report.capability,
                process: report.process,
                image: report.generatedImage,
                outputImage: report.output?.image,
                storage: report.storage,
                checks,
                reportFiles,
            },
            null,
            2,
        ),
    );
    if (!report.passed) process.exitCode = 1;
} finally {
    await Promise.allSettled([
        application.close(),
        businessApi.close(),
        localImageServer?.close() ?? Promise.resolve(),
    ]);
}

function evaluate(options: {
    result: ProcessRunResult;
    output: PosterOutput | undefined;
    generatedImage: GeneratedImage | undefined;
    requiredText: string;
    storageExpected: boolean;
    storedObject: StoredObject | undefined;
    downloadedImagePassed: boolean | undefined;
    httpStatus: number;
    capability: BusinessApiEvidence;
}): Check[] {
    const prompt = options.output?.prompt ?? "";
    const ratio = options.output
        ? options.output.image.width / options.output.image.height
        : undefined;
    const checks: Check[] = [
        {
            criterion:
                "product request entered through POST /execute and returned HTTP 200",
            passed: options.httpStatus === 200,
        },
        {
            criterion: "minimal-zine-poster/v1 completed successfully",
            passed: options.result.status === "succeeded",
        },
        {
            criterion:
                "production HTTP Adapter called the owned POST /posters capability exactly once",
            passed: options.capability.calls === 1,
        },
        {
            criterion:
                "POST /posters received the Process runId as its idempotency key",
            passed: options.capability.idempotencyKey === options.result.runId,
        },
        {
            criterion: "Runtime Skill compiled an exact four-paragraph prompt",
            passed:
                prompt.split(/\n\s*\n/u).filter((part) => part.trim())
                    .length === 4,
        },
        {
            criterion: "compiled prompt preserves the required image text",
            passed: prompt.includes(options.requiredText),
        },
        {
            criterion: "recipe records all six fixed variation axes",
            passed:
                options.output !== undefined &&
                Object.keys(options.output.recipe).length === 6,
        },
        {
            criterion:
                "prompt specifies vertical 3:5 aged paper and large negative space",
            passed:
                /(?:vertical[^.\n]{0,30}3:5|3:5[^.\n]{0,30}vertical)/iu.test(
                    prompt,
                ) &&
                /aged paper|old paper|paper canvas/iu.test(prompt) &&
                /negative space/iu.test(prompt),
        },
        {
            criterion: "prompt names a saturated color and print treatment",
            passed:
                /saturated|high-chroma/iu.test(prompt) &&
                /xerox|risograph|halftone|letterpress|scan|ink bleed|misregistration/iu.test(
                    prompt,
                ),
        },
        {
            criterion: "GPT Image returned a non-trivial raster image",
            passed:
                options.generatedImage !== undefined &&
                options.generatedImage.bytes.length > 10_000,
        },
        {
            criterion: "Process output keeps the requested 3:5 aspect ratio",
            passed: ratio !== undefined && Math.abs(ratio - 3 / 5) < 0.03,
        },
        {
            criterion:
                "Process image URL downloads the exact generated raster bytes",
            passed: options.downloadedImagePassed === true,
        },
        {
            criterion: options.storageExpected
                ? "configured object storage returned an HTTPS image URL"
                : "controlled local Business API served the generated image URL",
            passed: options.storageExpected
                ? options.storedObject?.url.startsWith("https://") === true
                : options.output?.image.url.startsWith("http://127.0.0.1:") ===
                  true,
        },
    ];
    return checks;
}

async function imageUrlMatches(
    url: string,
    expected: Uint8Array,
): Promise<boolean> {
    try {
        const response = await fetch(url);
        if (!response.ok) return false;
        return Buffer.from(await response.arrayBuffer()).equals(
            Buffer.from(expected),
        );
    } catch {
        return false;
    }
}

async function writeReport(report: Report): Promise<{
    json: string;
    markdown: string;
}> {
    await mkdir(reportDirectory, { recursive: true });
    const json = join(reportDirectory, "latest.json");
    const markdown = join(reportDirectory, "latest.md");
    await Promise.all([
        writeFile(json, `${JSON.stringify(report, null, 2)}\n`),
        writeFile(markdown, renderReport(report)),
    ]);
    return { json, markdown };
}

function renderReport(report: Report): string {
    const lines = [
        "# Minimal Zine Poster Business Acceptance",
        "",
        `- Result: **${report.passed ? "PASS" : "FAIL"}**`,
        `- Process: \`${report.process.id}/${report.process.version}\``,
        `- Run ID: \`${report.process.runId}\``,
        `- Agent: \`${report.agent.provider}/${report.agent.model}\` via \`${report.agent.apiMode}\``,
        `- Product Interface: \`${report.transport.request}\` → HTTP ${report.transport.httpStatus}`,
        `- Business Capability: \`${report.capability.request}\` × ${report.capability.calls}`,
        `- Runtime Skill SHA-256: \`${report.skill.sha256}\``,
        "- Credentials and Base URLs: omitted",
        "",
        "## Flow",
        "",
        "The acceptance starts the production Composition, submits the public brief and optional exact text through POST /execute, and resolves minimal-zine-poster/v1 from the production catalog. The Registration asks the no-Tool Agent to compile the reviewed Runtime Skill output, validates the four-paragraph prompt and six-axis recipe, then the production HTTP Adapter calls the owned POST /posters Business Capability with the Process run ID. That controlled local Capability calls GPT Image, saves the raster, and either uploads it to configured object storage or serves it from a temporary local HTTP endpoint for byte verification.",
        "",
        "## Input",
        "",
        fencedText(JSON.stringify(report.input, null, 2)),
        "",
    ];
    if (report.output) {
        lines.push(
            "## Compiled prompt",
            "",
            `- Recipe: \`${Object.values(report.output.recipe).join(" / ")}\``,
            `- Interpretation: ${report.output.interpretation}`,
            "",
            fencedText(report.output.prompt),
            "",
            "## Process image output",
            "",
            `- URL: ${report.output.image.url}`,
            `- Type: \`${report.output.image.contentType}\``,
            `- Dimensions: ${report.output.image.width}x${report.output.image.height}`,
            `- Expires at: \`${report.output.image.expiresAt ?? "does not expire"}\``,
            "",
        );
    }
    if (report.generatedImage) {
        lines.push(
            "## Generated raster evidence",
            "",
            `- Provider: \`${report.generatedImage.provider}\``,
            `- Model: \`${report.generatedImage.model}\``,
            `- Bytes: ${report.generatedImage.bytes}`,
            `- SHA-256: \`${report.generatedImage.sha256}\``,
            "",
            `![Generated minimal zine poster](${resolve(report.generatedImage.file)})`,
            "",
        );
    }
    if (report.process.error) {
        lines.push(
            "## Process error",
            "",
            fencedText(JSON.stringify(report.process.error, null, 2)),
            "",
        );
    }
    for (const [name, error] of Object.entries(report.errors)) {
        lines.push(`## ${name} error`, "", fencedText(error), "");
    }
    lines.push("## Checks", "");
    for (const check of report.checks) {
        lines.push(`- [${check.passed ? "x" : " "}] ${check.criterion}`);
    }
    lines.push("", `Final verdict: **${report.passed ? "PASS" : "FAIL"}**`, "");
    return `${lines.join("\n")}\n`;
}

function successfulPosterOutput(
    result: ProcessRunResult,
): PosterOutput | undefined {
    if (result.status !== "succeeded" || !isRecord(result.output)) {
        return undefined;
    }
    return result.output as PosterOutput;
}

type BusinessApiEvidence = Readonly<{
    calls: number;
    idempotencyKey?: string;
}>;

type PosterBusinessApi = Readonly<{
    url: string;
    evidence: () => BusinessApiEvidence;
    close: () => Promise<void>;
}>;

async function startPosterBusinessApi(
    capability: PosterRenderingCapability,
): Promise<PosterBusinessApi> {
    const renders = new Map<string, Promise<PosterImage>>();
    let calls = 0;
    let idempotencyKey: string | undefined;
    const server = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/posters") {
            response.writeHead(404).end();
            return;
        }

        let input: { prompt: string; aspectRatio: "3:5" };
        let requestKey: string;
        try {
            input = parsePosterRequest(await readJsonBody(request));
            requestKey = parseIdempotencyKey(
                request.headers["idempotency-key"],
            );
        } catch {
            writeJson(response, 400, {
                error: {
                    code: "INVALID_INPUT",
                    message: "Poster request is invalid",
                },
            });
            return;
        }

        calls += 1;
        idempotencyKey = requestKey;
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once("aborted", abort);
        let pending = renders.get(requestKey);
        if (!pending) {
            pending = capability.render(input, {
                signal: controller.signal,
                idempotencyKey: requestKey,
            });
            renders.set(requestKey, pending);
        }
        try {
            writeJson(response, 200, await pending);
        } catch {
            if (renders.get(requestKey) === pending) renders.delete(requestKey);
            writeJson(response, 503, {
                error: {
                    code: "POSTER_RENDERING_UNAVAILABLE",
                    message: "Poster rendering is unavailable",
                },
            });
        } finally {
            request.off("aborted", abort);
        }
    });
    const url = await listenServer(server);
    return Object.freeze({
        url,
        evidence: () =>
            Object.freeze({
                calls,
                ...(idempotencyKey ? { idempotencyKey } : {}),
            }),
        close: () => closeServer(server),
    });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 65_536) throw new Error("Poster request is too large");
        chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parsePosterRequest(value: unknown): {
    prompt: string;
    aspectRatio: "3:5";
} {
    if (
        !isRecord(value) ||
        Object.keys(value).length !== 2 ||
        typeof value.prompt !== "string" ||
        value.prompt.trim().length === 0 ||
        value.prompt.length > 50_000 ||
        value.aspectRatio !== "3:5"
    ) {
        throw new Error("Poster request is invalid");
    }
    return { prompt: value.prompt, aspectRatio: "3:5" };
}

function parseIdempotencyKey(value: string | string[] | undefined): string {
    if (
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 200 ||
        !/^[A-Za-z0-9_-]+$/u.test(value)
    ) {
        throw new Error("Poster idempotency key is invalid");
    }
    return value;
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
        throw new Error("Business API did not bind an IP address");
    }
    return `http://127.0.0.1:${address.port}`;
}

function parseProcessResult(value: unknown): ProcessRunResult {
    if (
        !isRecord(value) ||
        typeof value.runId !== "string" ||
        (value.status !== "succeeded" && value.status !== "failed")
    ) {
        throw new Error("POST /execute returned an invalid Process result");
    }
    if (value.status === "succeeded" && !("output" in value)) {
        throw new Error("POST /execute returned no Process output");
    }
    if (
        value.status === "failed" &&
        (!isRecord(value.error) ||
            typeof value.error.code !== "string" ||
            typeof value.error.message !== "string")
    ) {
        throw new Error("POST /execute returned an invalid Process error");
    }
    return value as ProcessRunResult;
}

type LocalImageServer = { url: string; close: () => Promise<void> };

async function startLocalImageServer(
    image: GeneratedImage,
): Promise<LocalImageServer> {
    const path = `/poster.${image.outputFormat}`;
    const server = createServer((request, response) => {
        if (request.method !== "GET" || request.url !== path) {
            response.writeHead(404).end();
            return;
        }
        writeImage(response, image);
    });
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
        throw new Error("Local image server did not bind an IP address");
    }
    return {
        url: `http://127.0.0.1:${address.port}${path}`,
        close: () => closeServer(server),
    };
}

function writeImage(response: ServerResponse, image: GeneratedImage): void {
    response.writeHead(200, {
        "content-type": image.mimeType,
        "content-length": String(image.bytes.length),
        "cache-control": "no-store",
    });
    response.end(image.bytes);
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
    });
}

function imageDimensions(
    image: GeneratedImage,
    requestedSize: string,
): { width: number; height: number } {
    if (image.width && image.height) {
        return { width: image.width, height: image.height };
    }
    const match = /^(\d+)x(\d+)$/u.exec(requestedSize);
    if (!match) throw new Error("GPT image size must use WIDTHxHEIGHT");
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
        throw new Error("GPT image size is invalid");
    }
    return { width, height };
}

function posterContentType(value: string): PosterImage["contentType"] {
    if (
        value === "image/png" ||
        value === "image/jpeg" ||
        value === "image/webp"
    ) {
        return value;
    }
    throw new Error("GPT Image returned an unsupported content type");
}

function parseQuality(value: string | undefined): GptImageQuality {
    if (
        value === undefined ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "auto"
    ) {
        return value ?? "low";
    }
    throw new Error("GPT_IMAGE_QUALITY must be low, medium, high, or auto");
}

function parseOutputFormat(value: string | undefined): GptImageOutputFormat {
    if (
        value === undefined ||
        value === "png" ||
        value === "jpeg" ||
        value === "webp"
    ) {
        return value ?? "png";
    }
    throw new Error("GPT_IMAGE_OUTPUT_FORMAT must be png, jpeg, or webp");
}

function parsePositiveInteger(
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

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function formatErrorChain(error: unknown): string {
    const messages: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current !== undefined && current !== null && !seen.has(current)) {
        seen.add(current);
        messages.push(
            current instanceof Error ? current.message : String(current),
        );
        current = current instanceof Error ? current.cause : undefined;
    }
    const chain = messages.join(" <- caused by: ");
    return chain.length <= 1_000 ? chain : `${chain.slice(0, 1_000)}…`;
}

function fencedText(value: string): string {
    const fence = value.includes("```") ? "````" : "```";
    return `${fence}text\n${value}\n${fence}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
