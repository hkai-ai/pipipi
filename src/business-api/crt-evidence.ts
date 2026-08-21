/** CRT 渲染证据留存：按策略把 source/raw/final 图像与 manifest 落盘存证 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
    CrtAspectRatio,
    CrtGrain,
    CrtPalette,
} from "../processes/crt/style.js";
import type {
    GptImageQuality,
    GptImageUsage,
} from "./openai-image-generation.js";

export const crtEvidenceModes = ["off", "metadata", "full"] as const;

export type CrtEvidenceMode = (typeof crtEvidenceModes)[number];

export type CrtEvidencePolicy = Readonly<
    { mode: "off" } | { mode: "metadata" | "full"; directory: string }
>;

export type CrtEvidenceResult = Readonly<{
    mode: CrtEvidenceMode;
    runDirectory?: string;
    manifestFile?: string;
    sourceFile?: string;
    rawFile?: string;
    finalFile?: string;
}>;

type Raster = Readonly<{
    bytes: Uint8Array;
    contentType: "image/png" | "image/jpeg" | "image/webp";
    width: number;
    height: number;
}>;

export type CrtEvidenceInput = Readonly<{
    runId: string;
    createdAt: string;
    provider: string;
    model: string;
    quality: GptImageQuality;
    palette: CrtPalette;
    aspectRatio: CrtAspectRatio;
    grain: CrtGrain;
    source?: Raster;
    sourceUrlSha256?: string;
    raw: Raster &
        Readonly<{
            requestId?: string;
            usage?: GptImageUsage;
        }>;
    final: Omit<Raster, "contentType"> &
        Readonly<{
            contentType: "image/png";
            colors: readonly string[];
            blockSize: number;
        }>;
}>;

export function resolveCrtEvidencePolicy(
    environment: Readonly<Record<string, string | undefined>>,
    defaults: Readonly<{
        defaultMode: CrtEvidenceMode;
        defaultDirectory?: string;
    }>,
): CrtEvidencePolicy {
    const candidate =
        environment.CRT_IMAGE_EVIDENCE_MODE?.trim() || defaults.defaultMode;
    if (!crtEvidenceModes.includes(candidate as CrtEvidenceMode)) {
        throw new Error(
            "CRT_IMAGE_EVIDENCE_MODE must be off, metadata, or full",
        );
    }
    const mode = candidate as CrtEvidenceMode;
    if (mode === "off") return Object.freeze({ mode });

    const directory =
        environment.CRT_IMAGE_EVIDENCE_DIRECTORY?.trim() ||
        defaults.defaultDirectory?.trim();
    if (!directory) {
        throw new Error(
            "CRT_IMAGE_EVIDENCE_DIRECTORY is required when CRT image evidence is enabled",
        );
    }
    return Object.freeze({ mode, directory: resolve(directory) });
}

export async function saveCrtEvidence(
    policy: CrtEvidencePolicy,
    input: CrtEvidenceInput,
): Promise<CrtEvidenceResult> {
    if (policy.mode === "off") return Object.freeze({ mode: "off" });
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(input.runId)) {
        throw new Error("CRT evidence runId is invalid");
    }

    const runDirectory = join(policy.directory, input.runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const sourceName = input.source
        ? `source.${extensionFor(input.source.contentType)}`
        : undefined;
    const rawName = `raw-gpt-image-2.${extensionFor(input.raw.contentType)}`;
    const finalName = "final-crt.png";
    const manifestFile = join(runDirectory, "manifest.json");
    const sourceFile = sourceName ? join(runDirectory, sourceName) : undefined;
    const rawFile = join(runDirectory, rawName);
    const finalFile = join(runDirectory, finalName);

    if (policy.mode === "full") {
        await Promise.all([
            ...(sourceFile && input.source
                ? [writeFile(sourceFile, input.source.bytes, { mode: 0o600 })]
                : []),
            writeFile(rawFile, input.raw.bytes, { mode: 0o600 }),
            writeFile(finalFile, input.final.bytes, { mode: 0o600 }),
        ]);
    }

    const file = (name: string): { file: string } | object =>
        policy.mode === "full" ? { file: name } : {};
    const manifest = {
        schemaVersion: 1,
        createdAt: input.createdAt,
        process: {
            id: "crt-interface-image",
            version: "v1",
            runId: input.runId,
        },
        retention: { mode: policy.mode },
        rendering: {
            provider: input.provider,
            model: input.model,
            operation: "reference-edit",
            quality: input.quality,
            ...(input.raw.requestId ? { requestId: input.raw.requestId } : {}),
            ...(input.raw.usage ? { usage: input.raw.usage } : {}),
        },
        request: {
            palette: input.palette,
            aspectRatio: input.aspectRatio,
            grain: input.grain,
        },
        source: input.source
            ? {
                  contentType: input.source.contentType,
                  width: input.source.width,
                  height: input.source.height,
                  bytes: input.source.bytes.byteLength,
                  sha256: sha256(input.source.bytes),
                  ...(sourceName ? file(sourceName) : {}),
              }
            : { urlSha256: input.sourceUrlSha256 },
        raw: {
            contentType: input.raw.contentType,
            width: input.raw.width,
            height: input.raw.height,
            bytes: input.raw.bytes.byteLength,
            sha256: sha256(input.raw.bytes),
            ...file(rawName),
        },
        final: {
            contentType: input.final.contentType,
            width: input.final.width,
            height: input.final.height,
            bytes: input.final.bytes.byteLength,
            sha256: sha256(input.final.bytes),
            colors: input.final.colors,
            blockSize: input.final.blockSize,
            ...file(finalName),
        },
        omitted: ["credentials", "baseUrl", "prompt", "revisedPrompt"],
    };
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
    });

    return Object.freeze({
        mode: policy.mode,
        runDirectory,
        manifestFile,
        ...(policy.mode === "full" && sourceFile ? { sourceFile } : {}),
        ...(policy.mode === "full" ? { rawFile, finalFile } : {}),
    });
}

function extensionFor(contentType: Raster["contentType"]): string {
    if (contentType === "image/jpeg") return "jpg";
    if (contentType === "image/webp") return "webp";
    return "png";
}

function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}
