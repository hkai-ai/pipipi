import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { startLocalCrtBusinessApi } from "../src/business-api/crt-server.js";
import { OpenAIImageGenerationError } from "../src/business-api/openai-image-generation.js";

describe("local CRT Business API", () => {
    it("reports liveness and readiness", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-crt-api-"));
        const api = await startLocalCrtBusinessApi({
            directory,
            imageClient: {
                edit: async () => {
                    throw new Error("not called");
                },
            },
        });

        try {
            for (const path of ["/healthz", "/readyz"]) {
                const response = await fetch(`${api.url}${path}`);
                expect(response.status).toBe(200);
                await expect(response.json()).resolves.toEqual({
                    status: "ok",
                });
            }
        } finally {
            await api.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("passes a public URL to the image provider and serves one idempotent finalized PNG", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-crt-api-"));
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
            const sourceImageUrl =
                "https://images.example.com/source/portrait.png?token=test";
            const request = {
                sourceImageUrl,
                prompt: "Transform the attached source image into a CRT interface.",
                palette: "经典",
                aspectRatio: "4:3",
                grain: "normal",
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
            expect(edit).toHaveBeenCalledWith(
                expect.objectContaining({ imageUrl: sourceImageUrl }),
            );
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
            ]);
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

    it("persists one object-storage result across restarts", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-crt-api-"));
        const generated = await sharp({
            create: {
                width: 320,
                height: 240,
                channels: 3,
                background: "#6c8f79",
            },
        })
            .png()
            .toBuffer();
        const upload = vi.fn(async (request) => ({
            provider: "aliyun-oss",
            bucket: "crt-test",
            objectKey: request.objectKey,
            url: "https://assets.example.com/crt/run-oss.png",
            urlAccess: "signed" as const,
            urlExpiresAt: "2026-08-11T01:00:00.000Z",
            contentType: request.contentType,
            size: request.bytes.byteLength,
        }));
        const edit = vi.fn(async () => ({
            bytes: generated,
            mimeType: "image/png" as const,
            outputFormat: "png" as const,
        }));
        const request = {
            sourceImageUrl: "https://images.example.com/source.png",
            prompt: "Transform the attached source image.",
            palette: "经典",
            aspectRatio: "4:3",
            grain: "normal",
        };
        const api = await startLocalCrtBusinessApi({
            directory,
            imageClient: { edit },
            storage: { provider: "aliyun-oss", upload },
            objectPrefix: "crt-production",
        });

        try {
            const response = await fetch(`${api.url}/crt-images`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": "run-oss",
                },
                body: JSON.stringify(request),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                url: "https://assets.example.com/crt/run-oss.png",
                expiresAt: "2026-08-11T01:00:00.000Z",
            });
            expect(upload).toHaveBeenCalledWith(
                expect.objectContaining({
                    objectKey: "crt-production/run-oss.png",
                    contentType: "image/png",
                }),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
            expect(api.evidence().storage).toBe("aliyun-oss");

            await api.close();
            const afterRestart = vi.fn(async () => {
                throw new Error("image provider must not run after restart");
            });
            const restarted = await startLocalCrtBusinessApi({
                directory,
                imageClient: { edit: afterRestart },
                storage: { provider: "aliyun-oss", upload },
                objectPrefix: "crt-production",
            });
            try {
                const repeated = await fetch(`${restarted.url}/crt-images`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "idempotency-key": "run-oss",
                    },
                    body: JSON.stringify(request),
                });
                expect(repeated.status).toBe(200);
                expect(await repeated.json()).toMatchObject({
                    url: "https://assets.example.com/crt/run-oss.png",
                });
                expect(afterRestart).not.toHaveBeenCalled();
                expect(edit).toHaveBeenCalledOnce();
                expect(upload).toHaveBeenCalledOnce();
            } finally {
                await restarted.close();
            }
        } finally {
            await api.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("treats a grain change under one idempotency key as a conflict", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-crt-api-"));
        const generated = await sharp({
            create: {
                width: 320,
                height: 240,
                channels: 3,
                background: { r: 20, g: 40, b: 30 },
            },
        })
            .png()
            .toBuffer();
        const edit = vi.fn(async () => ({
            bytes: generated,
            mimeType: "image/png",
            outputFormat: "png" as const,
            width: 320,
            height: 240,
        }));
        const api = await startLocalCrtBusinessApi({
            directory,
            imageClient: { edit },
        });

        try {
            const first = await requestCrtImage(api.url, "run-grain", "normal");
            const changed = await requestCrtImage(
                api.url,
                "run-grain",
                "coarse",
            );
            const repeated = await requestCrtImage(
                api.url,
                "run-grain",
                "normal",
            );

            expect(first.status).toBe(200);
            expect(changed.status).toBe(409);
            expect(await changed.json()).toMatchObject({
                error: { code: "IDEMPOTENCY_CONFLICT" },
            });
            expect(repeated.status).toBe(200);
            expect(await repeated.json()).toEqual(await first.json());
            expect(edit).toHaveBeenCalledOnce();
        } finally {
            await api.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("separates failures before and after the edit is charged", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-crt-api-"));
        const generated = await sharp({
            create: {
                width: 320,
                height: 240,
                channels: 3,
                background: { r: 20, g: 40, b: 30 },
            },
        })
            .png()
            .toBuffer();
        const beforeEdit = vi.fn(async () => {
            throw new OpenAIImageGenerationError("source image unreachable", {
                status: 502,
            });
        });
        const afterEdit = vi.fn(async () => ({
            bytes: generated,
            mimeType: "image/png",
            outputFormat: "png" as const,
            width: 320,
            height: 240,
        }));
        const failingStorage = {
            provider: "test-storage",
            upload: async () => {
                throw new Error("private bucket detail");
            },
        };

        const unavailable = await startLocalCrtBusinessApi({
            directory: join(directory, "before"),
            imageClient: { edit: beforeEdit },
        });
        const incomplete = await startLocalCrtBusinessApi({
            directory: join(directory, "after"),
            imageClient: { edit: afterEdit },
            storage: failingStorage,
        });

        try {
            const beforeResponse = await requestCrtImage(
                unavailable.url,
                "run-before",
            );
            const afterResponse = await requestCrtImage(
                incomplete.url,
                "run-after",
            );

            expect(beforeResponse.status).toBe(503);
            expect(await beforeResponse.json()).toEqual({
                error: {
                    code: "CRT_RENDERING_UNAVAILABLE",
                    message: "CRT rendering is unavailable",
                },
            });
            expect(unavailable.evidence()).toMatchObject({
                editAttempts: 1,
                edits: 0,
            });

            expect(afterResponse.status).toBe(503);
            expect(await afterResponse.json()).toEqual({
                error: {
                    code: "CRT_RENDERING_INCOMPLETE",
                    message:
                        "CRT rendering completed but the result could not be delivered",
                },
            });
            expect(incomplete.evidence()).toMatchObject({
                editAttempts: 1,
                edits: 1,
            });
            expect(incomplete.evidence().renderingFailure).toMatchObject({
                name: "Error",
                message: "private bucket detail",
            });
        } finally {
            await unavailable.close();
            await incomplete.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("records a safe rendering failure for local acceptance diagnostics", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-crt-api-"));
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
            const response = await fetch(`${api.url}/crt-images`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": "run-failed",
                },
                body: JSON.stringify({
                    sourceImageUrl: "https://images.example.com/source.png",
                    prompt: "Transform the attached source image.",
                    palette: "经典",
                    aspectRatio: "4:3",
                    grain: "normal",
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
                    sourceImageUrl: "https://images.example.com/source.png",
                    prompt: "Transform the attached source image.",
                    palette: "经典",
                    aspectRatio: "4:3",
                    grain: "normal",
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

function requestCrtImage(
    serviceUrl: string,
    idempotencyKey: string,
    grain: "fine" | "normal" | "coarse" = "normal",
): Promise<Response> {
    return fetch(`${serviceUrl}/crt-images`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
            sourceImageUrl: "https://images.example.com/source.png",
            prompt: "Transform the attached source image.",
            palette: "经典",
            aspectRatio: "4:3",
            grain,
        }),
    });
}

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
