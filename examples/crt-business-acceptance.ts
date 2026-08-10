import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import sharp from "sharp";
import { parseOpenAIApiMode } from "../src/agent-runtime/pi.js";
import { constructProcessingService } from "../src/app/api.js";
import type { ProcessRunResult } from "../src/process-runtime/index.js";
import type { CrtImage } from "../src/processes/crt/capability.js";
import {
    type CrtAspectRatio,
    type CrtPalette,
    crtAspectRatios,
    crtPaletteNames,
} from "../src/processes/crt/style.js";
import { resolveCrtEvidencePolicy } from "./support/crt-evidence.js";
import { createImageGenerationClient } from "./support/image-generation-config.js";
import {
    type LocalCrtBusinessApiEvidence,
    startLocalCrtBusinessApi,
} from "./support/local-crt-business-api.js";
import type { GptImageQuality } from "./support/openai-image-generation.js";

const sourcePath = resolve(required("CRT_SOURCE_IMAGE_FILE"));
const reportDirectory = resolve(
    process.env.CRT_ACCEPTANCE_REPORT_DIRECTORY ??
        "artifacts/crt-interface-image/acceptance",
);
const skillDirectory = resolve(
    process.env.CRT_IMAGE_SKILL_DIRECTORY ??
        ".pi/skills/tait-crt-interface-prompt",
);
const palette = parsePalette(process.env.CRT_IMAGE_PALETTE);
const aspectRatio = parseAspectRatio(process.env.CRT_IMAGE_ASPECT_RATIO);
const provider = process.env.PI_PROVIDER?.trim() || "openai";
const agentModel = process.env.PI_MODEL?.trim() || "gpt-5.6-terra";
const imageModel = process.env.CRT_IMAGE_MODEL?.trim() || "gpt-image-2";
const quality = parseQuality(process.env.CRT_IMAGE_QUALITY);
const imageTimeoutMs = parsePositiveInteger(
    process.env.CRT_IMAGE_TIMEOUT_MS,
    180_000,
    "CRT_IMAGE_TIMEOUT_MS",
);
const agentTimeoutMs = parsePositiveInteger(
    process.env.CRT_IMAGE_AGENT_TIMEOUT_MS,
    120_000,
    "CRT_IMAGE_AGENT_TIMEOUT_MS",
);
const processTimeoutMs = parsePositiveInteger(
    process.env.CRT_IMAGE_PROCESS_TIMEOUT_MS,
    agentTimeoutMs + imageTimeoutMs + 30_000,
    "CRT_IMAGE_PROCESS_TIMEOUT_MS",
);
const apiMode = parseOpenAIApiMode(process.env.OPENAI_API_MODE);
const source = await readFile(sourcePath);
const sourceContentType = detectSourceMimeType(source);
if (!sourceContentType) {
    throw new Error("CRT_SOURCE_IMAGE_FILE must be PNG, JPEG, or WebP");
}
if (source.length > 50 * 1024 * 1024) {
    throw new Error("CRT_SOURCE_IMAGE_FILE must not exceed 50 MB");
}

await mkdir(reportDirectory, { recursive: true });
const evidencePolicy = resolveCrtEvidencePolicy(process.env, {
    defaultMode: "full",
    defaultDirectory: join(reportDirectory, "runs"),
});
const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "pipipi-crt-acceptance-"),
);
const imageGeneration = createImageGenerationClient(process.env, {
    timeoutMs: imageTimeoutMs,
});
const businessApi = await startLocalCrtBusinessApi({
    directory: temporaryDirectory,
    imageClient: imageGeneration.client,
    provider: imageGeneration.provider,
    model: imageModel,
    quality,
    evidencePolicy,
});
let application:
    | ReturnType<typeof constructProcessingService>["application"]
    | undefined;

try {
    const uploadResponse = await fetch(`${businessApi.url}/assets`, {
        method: "POST",
        headers: {
            "content-type": sourceContentType,
            "x-file-name": basename(sourcePath),
        },
        body: source,
        signal: AbortSignal.timeout(30_000),
    });
    const uploadBody = await readJson(uploadResponse);
    const upload = parseUpload(uploadBody);

    const constructed = constructProcessingService({
        ...process.env,
        BUSINESS_API_BASE_URL: businessApi.url,
        PI_PROVIDER: provider,
        PI_MODEL: agentModel,
        OPENAI_API_MODE: apiMode,
        PI_CRT_SKILL_DIRECTORY: skillDirectory,
        CRT_API_TIMEOUT_MS: String(imageTimeoutMs + 20_000),
        PROCESS_TIMEOUT_MS: String(processTimeoutMs),
        ASYNC_PROCESS_RUNS_ENABLED: "false",
    });
    application = constructed.application;
    const { url: serviceUrl } = await application.listen();
    const processResponse = await fetch(`${serviceUrl}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageId: upload.sourceImageId,
                palette,
                aspectRatio,
            },
        }),
        signal: AbortSignal.timeout(processTimeoutMs + 10_000),
    });
    const result = parseProcessResult(await readJson(processResponse));
    const output = successfulCrtOutput(result);
    const downloaded = output
        ? await downloadImage(output.image.url, processTimeoutMs)
        : undefined;
    const outputFile = join(reportDirectory, "latest.png");
    if (downloaded) await writeFile(outputFile, downloaded, { mode: 0o600 });
    const imageInspection = downloaded
        ? await inspectImage(downloaded)
        : undefined;
    const evidence = businessApi.evidence();
    const checks = evaluate({
        uploadStatus: uploadResponse.status,
        processStatus: processResponse.status,
        result,
        output,
        upload,
        evidence,
        downloaded,
        imageInspection,
        palette,
        aspectRatio,
    });
    const report = {
        generatedAt: new Date().toISOString(),
        passed: checks.every((check) => check.passed),
        scope: "local no-OSS Business Process acceptance",
        source: {
            filename: basename(sourcePath),
            contentType: sourceContentType,
            bytes: source.length,
            sha256: sha256(source),
        },
        upload: {
            request: "POST /assets",
            httpStatus: uploadResponse.status,
            sourceImageId: upload.sourceImageId,
            width: upload.width,
            height: upload.height,
        },
        process: {
            request: "POST /execute",
            httpStatus: processResponse.status,
            id: "crt-interface-image",
            version: "v1",
            runId: result.runId,
            status: result.status,
            ...(result.status === "failed" ? { error: result.error } : {}),
        },
        agent: { provider, model: agentModel, apiMode },
        rendering: {
            request: "POST /crt-images",
            storage: evidence.storage,
            provider: imageGeneration.provider,
            model: imageModel,
            quality,
            palette,
            aspectRatio,
            calls: evidence.requests,
            editAttempts: evidence.editAttempts,
            imageEdits: evidence.edits,
            apiConfiguration:
                imageGeneration.provider === "fal"
                    ? "fal"
                    : process.env.OPENAI_IMAGE_BASE_URL?.trim() ||
                        process.env.OPENAI_IMAGE_API_KEY?.trim()
                      ? "image-specific"
                      : "shared",
            idempotencyKeyMatchesRunId:
                evidence.idempotencyKey === result.runId,
            colors: evidence.colors,
            blockSize: evidence.blockSize,
            imageRequestId: evidence.imageRequestId,
            failure: evidence.renderingFailure,
        },
        artifacts: evidence.artifacts,
        output: output
            ? {
                  ...output,
                  localFile: downloaded ? outputFile : undefined,
                  bytes: downloaded?.length,
                  sha256: downloaded ? sha256(downloaded) : undefined,
                  uniqueColors: imageInspection?.uniqueColors,
                  hasAlpha: imageInspection?.hasAlpha,
              }
            : undefined,
        checks,
    };
    const reportFiles = await writeReport(report, outputFile);
    console.log(
        JSON.stringify(
            {
                passed: report.passed,
                scope: report.scope,
                upload: report.upload,
                process: report.process,
                rendering: report.rendering,
                artifacts: report.artifacts,
                output: report.output,
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
        application?.close() ?? Promise.resolve(),
        businessApi.close(),
    ]);
    await rm(temporaryDirectory, { recursive: true, force: true });
}

type Check = Readonly<{ criterion: string; passed: boolean }>;

function evaluate(options: {
    uploadStatus: number;
    processStatus: number;
    result: ProcessRunResult;
    output: { aspectRatio: CrtAspectRatio; image: CrtImage } | undefined;
    upload: UploadResult;
    evidence: LocalCrtBusinessApiEvidence;
    downloaded: Buffer | undefined;
    imageInspection:
        | {
              width: number;
              height: number;
              hasAlpha: boolean;
              uniqueColors: number;
          }
        | undefined;
    palette: CrtPalette;
    aspectRatio: CrtAspectRatio;
}): Check[] {
    return [
        {
            criterion: "local POST /assets accepted the source raster",
            passed:
                options.uploadStatus === 201 &&
                options.evidence.uploads === 1 &&
                options.evidence.sourceImageId === options.upload.sourceImageId,
        },
        {
            criterion:
                "product request entered through POST /execute and resolved crt-interface-image/v1",
            passed:
                options.processStatus === 200 &&
                options.result.status === "succeeded",
        },
        {
            criterion:
                "production HTTP Adapter called local POST /crt-images exactly once",
            passed: options.evidence.requests === 1,
        },
        {
            criterion: "one GPT Image 2 reference edit was performed",
            passed: options.evidence.edits === 1,
        },
        {
            criterion: "POST /crt-images received the Process runId",
            passed: options.evidence.idempotencyKey === options.result.runId,
        },
        {
            criterion:
                "Process output exposes only the requested aspect ratio and PNG reference",
            passed:
                options.output !== undefined &&
                options.output.aspectRatio === options.aspectRatio &&
                options.output.image.contentType === "image/png" &&
                options.output.image.url.startsWith("http://127.0.0.1:"),
        },
        {
            criterion: "local result URL downloads the finalized raster",
            passed:
                options.downloaded !== undefined &&
                options.downloaded.length > 10_000 &&
                sha256(options.downloaded) === options.evidence.outputSha256,
        },
        {
            criterion:
                "deterministic finalizer produced an opaque target-size PNG",
            passed:
                options.output !== undefined &&
                options.imageInspection !== undefined &&
                options.imageInspection.width === options.output.image.width &&
                options.imageInspection.height ===
                    options.output.image.height &&
                !options.imageInspection.hasAlpha,
        },
        {
            criterion: `deterministic finalizer restricted output to the ${options.palette} palette`,
            passed:
                options.imageInspection !== undefined &&
                options.evidence.colors !== undefined &&
                options.imageInspection.uniqueColors ===
                    options.evidence.colors.length,
        },
        {
            criterion: "no OSS or remote object storage was used",
            passed: options.evidence.storage === "local-filesystem",
        },
        {
            criterion: `server-owned ${options.evidence.artifacts.mode} evidence policy completed`,
            passed:
                options.evidence.artifacts.mode === evidencePolicy.mode &&
                (evidencePolicy.mode === "off" ||
                    options.evidence.artifacts.manifestFile !== undefined),
        },
    ];
}

type UploadResult = Readonly<{
    sourceImageId: string;
    contentType: string;
    bytes: number;
    width: number;
    height: number;
}>;

function parseUpload(value: unknown): UploadResult {
    if (
        !isRecord(value) ||
        typeof value.sourceImageId !== "string" ||
        typeof value.contentType !== "string" ||
        typeof value.bytes !== "number" ||
        typeof value.width !== "number" ||
        typeof value.height !== "number"
    ) {
        throw new Error("POST /assets returned an invalid response");
    }
    return value as UploadResult;
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

function successfulCrtOutput(
    result: ProcessRunResult,
): { aspectRatio: CrtAspectRatio; image: CrtImage } | undefined {
    if (
        result.status !== "succeeded" ||
        !isRecord(result.output) ||
        typeof result.output.aspectRatio !== "string" ||
        !isRecord(result.output.image)
    ) {
        return undefined;
    }
    return result.output as { aspectRatio: CrtAspectRatio; image: CrtImage };
}

async function downloadImage(url: string, timeoutMs: number): Promise<Buffer> {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || response.headers.get("content-type") !== "image/png") {
        throw new Error("Process image URL did not return PNG");
    }
    return Buffer.from(await response.arrayBuffer());
}

async function inspectImage(bytes: Uint8Array): Promise<{
    width: number;
    height: number;
    hasAlpha: boolean;
    uniqueColors: number;
}> {
    const metadata = await sharp(bytes).metadata();
    if (!metadata.width || !metadata.height || metadata.format !== "png") {
        throw new Error("Final output is not a dimensioned PNG");
    }
    const { data, info } = await sharp(bytes)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const colors = new Set<string>();
    for (let offset = 0; offset < data.length; offset += info.channels) {
        colors.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`);
    }
    return {
        width: metadata.width,
        height: metadata.height,
        hasAlpha: metadata.hasAlpha,
        uniqueColors: colors.size,
    };
}

async function writeReport(
    report: Record<string, unknown> & { passed: boolean; checks: Check[] },
    outputFile: string,
): Promise<{ json: string; markdown: string; image?: string }> {
    const json = join(reportDirectory, "latest.json");
    const markdown = join(reportDirectory, "latest.md");
    const processReport = report.process as Record<string, unknown>;
    const rendering = report.rendering as Record<string, unknown>;
    const artifacts = report.artifacts as
        | LocalCrtBusinessApiEvidence["artifacts"]
        | undefined;
    const lines = [
        "# CRT Interface Image Business Acceptance",
        "",
        `- Result: **${report.passed ? "PASS" : "FAIL"}**`,
        `- Scope: ${report.scope}`,
        `- Process: \`crt-interface-image/v1\``,
        `- Run ID: \`${String(processReport.runId)}\``,
        `- Image provider: \`${String(rendering.provider)}\``,
        `- Image model: \`${String(rendering.model)}\``,
        `- Palette / aspect ratio: \`${String(rendering.palette)} / ${String(rendering.aspectRatio)}\``,
        "- Storage: local temporary asset service and local report file; no OSS",
        `- Evidence retention: \`${artifacts?.mode ?? "off"}\``,
        "- Credentials, Prompt text, Base URLs, and revised Prompt: omitted",
        "",
    ];
    if (artifacts?.manifestFile) {
        lines.push(
            "## Retained evidence",
            "",
            `- Manifest: [manifest.json](${resolve(artifacts.manifestFile)})`,
        );
        if (artifacts.sourceFile) {
            lines.push(
                `- Uploaded source: [${basename(artifacts.sourceFile)}](${resolve(artifacts.sourceFile)})`,
            );
        }
        if (artifacts.rawFile) {
            lines.push(
                `- Raw GPT Image 2 result: [${basename(artifacts.rawFile)}](${resolve(artifacts.rawFile)})`,
            );
        }
        if (artifacts.finalFile) {
            lines.push(
                `- Final CRT result: [${basename(artifacts.finalFile)}](${resolve(artifacts.finalFile)})`,
            );
        }
        lines.push("");
    }
    if (report.output) {
        lines.push(
            "## Finalized image",
            "",
            `![Generated CRT interface](${resolve(outputFile)})`,
            "",
        );
    }
    lines.push("## Checks", "");
    for (const check of report.checks) {
        lines.push(`- [${check.passed ? "x" : " "}] ${check.criterion}`);
    }
    lines.push("", `Final verdict: **${report.passed ? "PASS" : "FAIL"}**`, "");
    await Promise.all([
        writeFile(json, `${JSON.stringify(report, null, 2)}\n`),
        writeFile(markdown, `${lines.join("\n")}\n`),
    ]);
    return {
        json,
        markdown,
        ...(report.output ? { image: outputFile } : {}),
    };
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) throw new Error(`HTTP ${response.status} returned no JSON`);
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`HTTP ${response.status} returned invalid JSON`);
    }
}

function parsePalette(value: string | undefined): CrtPalette {
    const candidate = value?.trim() || "经典";
    if (!crtPaletteNames.includes(candidate as CrtPalette)) {
        throw new Error(
            `CRT_IMAGE_PALETTE must be one of ${crtPaletteNames.join(", ")}`,
        );
    }
    return candidate as CrtPalette;
}

function parseAspectRatio(value: string | undefined): CrtAspectRatio {
    const candidate = value?.trim() || "4:3";
    if (!crtAspectRatios.includes(candidate as CrtAspectRatio)) {
        throw new Error(
            `CRT_IMAGE_ASPECT_RATIO must be one of ${crtAspectRatios.join(", ")}`,
        );
    }
    return candidate as CrtAspectRatio;
}

function parseQuality(value: string | undefined): GptImageQuality {
    if (value === undefined || value === "low") return "low";
    if (value === "medium" || value === "high" || value === "auto") {
        return value;
    }
    throw new Error("CRT_IMAGE_QUALITY must be low, medium, high, or auto");
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

function detectSourceMimeType(
    bytes: Buffer,
): "image/png" | "image/jpeg" | "image/webp" | undefined {
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

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
