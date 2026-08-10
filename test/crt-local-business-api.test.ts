import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { startLocalCrtBusinessApi } from "../examples/support/local-crt-business-api.js";
import { OpenAIImageGenerationError } from "../examples/support/openai-image-generation.js";

describe("local CRT Business API", () => {
    it("accepts an uploaded image and serves one idempotent finalized PNG", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-crt-api-"));
        const source = await sharp({
            create: {
                width: 64,
                height: 48,
                channels: 3,
                background: "#d66a4d",
            },
        })
            .png()
            .toBuffer();
        const generated = await sharp({
            create: {
                width: 320,
                height: 240,
                channels: 3,
                background: "#6c8f79",
            },
        })
            .composite([
                {
                    input: await sharp({
                        create: {
                            width: 160,
                            height: 120,
                            channels: 3,
                            background: "#e1d5b5",
                        },
                    })
                        .png()
                        .toBuffer(),
                    left: 80,
                    top: 60,
                },
            ])
            .png()
            .toBuffer();
        const edit = vi.fn(async () => ({
            bytes: generated,
            mimeType: "image/png",
            outputFormat: "png" as const,
            width: 320,
            height: 240,
            requestId: "image-edit-1",
            usage: { inputTokens: 21, outputTokens: 34 },
        }));
        const evidenceDirectory = join(directory, "evidence");
        const api = await startLocalCrtBusinessApi({
            directory,
            imageClient: { edit },
            evidencePolicy: {
                mode: "full",
                directory: evidenceDirectory,
            },
        });

        try {
            const uploadResponse = await fetch(`${api.url}/assets`, {
                method: "POST",
                headers: {
                    "content-type": "image/png",
                    "x-file-name": "portrait.png",
                },
                body: source,
            });
            expect(uploadResponse.status).toBe(201);
            const upload = readRecord(await uploadResponse.json());
            expect(upload.sourceImageId).toMatch(/^asset_[a-f0-9-]+$/u);
            expect(upload).toMatchObject({
                contentType: "image/png",
                bytes: source.length,
                width: 64,
                height: 48,
            });
            expect(api.evidence()).toMatchObject({
                uploads: 1,
                sourceImageId: upload.sourceImageId,
                storage: "local-filesystem",
            });

            const request = {
                sourceImageId: upload.sourceImageId,
                prompt: "Transform the attached source image into a CRT interface.",
                palette: "经典",
                aspectRatio: "4:3",
            };
            const firstResponse = await fetch(`${api.url}/crt-images`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": "run-1",
                },
                body: JSON.stringify(request),
            });
            expect(firstResponse.status).toBe(200);
            const first = readRecord(await firstResponse.json());
            expect(first).toMatchObject({
                contentType: "image/png",
                width: 1600,
                height: 1200,
            });
            expect(first.url).toBe(`${api.url}/images/run-1.png`);

            const imageResponse = await fetch(String(first.url));
            expect(imageResponse.status).toBe(200);
            expect(imageResponse.headers.get("content-type")).toBe("image/png");
            const output = Buffer.from(await imageResponse.arrayBuffer());
            const metadata = await sharp(output).metadata();
            expect(metadata).toMatchObject({
                format: "png",
                width: 1600,
                height: 1200,
                hasAlpha: false,
            });
            const colors = await uniqueRgbColors(output);
            expect(colors).toEqual(new Set(["46,56,45", "222,228,224"]));

            const repeatedResponse = await fetch(`${api.url}/crt-images`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": "run-1",
                },
                body: JSON.stringify(request),
            });
            expect(repeatedResponse.status).toBe(200);
            expect(await repeatedResponse.json()).toEqual(first);
            expect(edit).toHaveBeenCalledOnce();
            expect(api.evidence()).toMatchObject({
                editAttempts: 1,
                edits: 1,
                artifacts: {
                    mode: "full",
                    runDirectory: join(evidenceDirectory, "run-1"),
                },
            });
            expect(await readdir(join(evidenceDirectory, "run-1"))).toEqual([
                "final-crt.png",
                "manifest.json",
                "raw-gpt-image-2.png",
                "source.png",
            ]);
            await expect(
                readFile(join(evidenceDirectory, "run-1", "source.png")),
            ).resolves.toEqual(source);
            await expect(
                readFile(
                    join(evidenceDirectory, "run-1", "raw-gpt-image-2.png"),
                ),
            ).resolves.toEqual(generated);
            await expect(
                readFile(join(evidenceDirectory, "run-1", "final-crt.png")),
            ).resolves.toEqual(output);
            const manifest = JSON.parse(
                await readFile(
                    join(evidenceDirectory, "run-1", "manifest.json"),
                    "utf8",
                ),
            ) as Record<string, unknown>;
            expect(manifest).toMatchObject({
                process: {
                    id: "crt-interface-image",
                    version: "v1",
                    runId: "run-1",
                },
                rendering: {
                    provider: "openai",
                    model: "gpt-image-2",
                    operation: "reference-edit",
                    requestId: "image-edit-1",
                    usage: { inputTokens: 21, outputTokens: 34 },
                },
                retention: { mode: "full" },
            });
        } finally {
            await api.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("records a safe rendering failure for local acceptance diagnostics", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-crt-api-"));
        const source = await sharp({
            create: {
                width: 64,
                height: 48,
                channels: 3,
                background: "#d66a4d",
            },
        })
            .png()
            .toBuffer();
        const edit = vi.fn(async () => {
            throw new OpenAIImageGenerationError(
                "GPT Image returned HTTP 404",
                { status: 404, code: "route_not_found" },
            );
        });
        const api = await startLocalCrtBusinessApi({
            directory,
            imageClient: { edit },
        });

        try {
            const uploadResponse = await fetch(`${api.url}/assets`, {
                method: "POST",
                headers: { "content-type": "image/png" },
                body: source,
            });
            const upload = readRecord(await uploadResponse.json());
            const response = await fetch(`${api.url}/crt-images`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": "run-failed",
                },
                body: JSON.stringify({
                    sourceImageId: upload.sourceImageId,
                    prompt: "Transform the attached source image.",
                    palette: "经典",
                    aspectRatio: "4:3",
                }),
            });

            expect(response.status).toBe(503);
            const repeated = await fetch(`${api.url}/crt-images`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": "run-failed",
                },
                body: JSON.stringify({
                    sourceImageId: upload.sourceImageId,
                    prompt: "Transform the attached source image.",
                    palette: "经典",
                    aspectRatio: "4:3",
                }),
            });
            expect(repeated.status).toBe(503);
            expect(edit).toHaveBeenCalledOnce();
            expect(api.evidence()).toMatchObject({
                editAttempts: 1,
                edits: 0,
            });
            expect(api.evidence().renderingFailure).toEqual({
                name: "OpenAIImageGenerationError",
                message: "GPT Image returned HTTP 404",
                status: 404,
                code: "route_not_found",
            });
        } finally {
            await api.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
});

function readRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a JSON object");
    }
    return value as Record<string, unknown>;
}

async function uniqueRgbColors(bytes: Uint8Array): Promise<Set<string>> {
    const { data, info } = await sharp(bytes)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const colors = new Set<string>();
    for (let offset = 0; offset < data.length; offset += info.channels) {
        colors.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`);
    }
    return colors;
}
