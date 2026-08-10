import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createImageGenerationClient } from "./support/image-generation-config.js";
import type { GptImageQuality } from "./support/openai-image-generation.js";

const sourcePath = resolve(required("CRT_SOURCE_IMAGE_FILE"));
const reportDirectory = resolve(
    process.env.CRT_IMAGE_REPORT_DIRECTORY ?? "artifacts/crt-interface-image",
);
const model = process.env.CRT_IMAGE_MODEL?.trim() || "gpt-image-2";
const size = process.env.CRT_IMAGE_SIZE?.trim() || "1600x1200";
const quality = parseQuality(process.env.CRT_IMAGE_QUALITY);
const timeoutMs = parsePositiveInteger(
    process.env.CRT_IMAGE_TIMEOUT_MS,
    180_000,
    "CRT_IMAGE_TIMEOUT_MS",
);
const prompt =
    process.env.CRT_IMAGE_PROMPT?.trim() ||
    'Transform the attached source image into one independently authored circa-1980s CRT computer-interface illustration. Preserve every prominent or interacting subject once, but rebuild them as a large blocky pixel cartoon behind asymmetric early Macintosh or Minitel windows; use one shared square lattice, hard checkerboard midtones, French bitmap labels, exactly one cursor, and the exact title-bar text "tait-crt-interface-skill". Use only #dee4e0 and #2e382d. Add dense scanlines and unmistakable barrel curvature around the outer 10%, and avoid tracing, automatic pixelation, gradients, modern UI, extra logos, or a physical monitor.';

const source = await readFile(sourcePath);
if (source.byteLength > 50 * 1024 * 1024) {
    throw new Error("CRT_SOURCE_IMAGE_FILE must not exceed 50 MB");
}
const mimeType = detectSourceMimeType(source);
if (!mimeType) {
    throw new Error("CRT_SOURCE_IMAGE_FILE must be PNG, JPEG, or WebP");
}

const imageGeneration = createImageGenerationClient(process.env, {
    timeoutMs,
});
const client = imageGeneration.client;
const generated = await client.edit({
    image: {
        bytes: source,
        mimeType,
        filename: basename(sourcePath),
    },
    prompt,
    model,
    size,
    quality,
    outputFormat: "png",
});

await mkdir(reportDirectory, { recursive: true });
const imageFile = join(reportDirectory, "latest.png");
await writeFile(imageFile, generated.bytes);

const checks = [
    {
        criterion: "GPT Image returned a non-trivial raster",
        passed: generated.bytes.byteLength > 10_000,
    },
    {
        criterion: "GPT Image returned PNG for the downstream finalizer",
        passed: generated.mimeType === "image/png",
    },
    {
        criterion: "GPT Image reported output dimensions",
        passed: generated.width !== undefined && generated.height !== undefined,
    },
];
const report = {
    generatedAt: new Date().toISOString(),
    passed: checks.every((check) => check.passed),
    scope: "GPT Image 2 edit-stage smoke; it does not replace CRT finalization or full Business Process acceptance",
    source: {
        filename: basename(sourcePath),
        contentType: mimeType,
        bytes: source.byteLength,
        sha256: sha256(source),
    },
    request: {
        provider: imageGeneration.provider,
        model,
        size,
        quality,
        promptSha256: sha256(prompt),
    },
    output: {
        file: imageFile,
        contentType: generated.mimeType,
        bytes: generated.bytes.byteLength,
        width: generated.width,
        height: generated.height,
        sha256: sha256(generated.bytes),
        requestId: generated.requestId,
        usage: generated.usage,
    },
    checks,
};
const reportFile = join(reportDirectory, "latest.json");
const markdownFile = join(reportDirectory, "latest.md");
await Promise.all([
    writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(
        markdownFile,
        `# CRT GPT Image edit smoke\n\n` +
            `- Result: **${report.passed ? "PASS" : "FAIL"}**\n` +
            `- Scope: ${report.scope}\n` +
            `- Provider: \`${imageGeneration.provider}\`\n` +
            `- Model: \`${model}\`\n` +
            `- Source: \`${report.source.filename}\` (${report.source.contentType}, ${report.source.bytes} bytes)\n` +
            `- Output: \`${generated.width ?? "unknown"}x${generated.height ?? "unknown"}\`, ${generated.bytes.byteLength} bytes\n` +
            `- Credentials, prompt text, and source pixels: omitted\n\n` +
            `![Generated CRT interface](${imageFile})\n\n` +
            `## Checks\n\n${checks.map((check) => `- [${check.passed ? "x" : " "}] ${check.criterion}`).join("\n")}\n`,
    ),
]);

console.log(
    JSON.stringify(
        {
            passed: report.passed,
            scope: report.scope,
            source: report.source,
            output: report.output,
            checks,
            reportFiles: { json: reportFile, markdown: markdownFile },
        },
        null,
        2,
    ),
);
if (!report.passed) process.exitCode = 1;

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
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

function parseQuality(value: string | undefined): GptImageQuality {
    if (value === undefined || value === "low") return "low";
    if (value === "medium" || value === "high" || value === "auto") {
        return value;
    }
    throw new Error("CRT_IMAGE_QUALITY must be low, medium, high, or auto");
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

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}
