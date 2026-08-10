import { describe, expect, it, vi } from "vitest";
import {
    FalImageGenerationClient,
    FalImageGenerationError,
    type FalSubscribe,
} from "../examples/support/fal-image-generation.js";

const minimalPng = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    Buffer.from("00000640000004b0", "hex"),
]);
const inlinePng = `data:image/png;base64,${minimalPng.toString("base64")}`;

describe("FAL image generation Adapter", () => {
    it("generates GPT Image 2 through the FAL queue client", async () => {
        const subscribe = vi.fn<FalSubscribe>(async () => ({
            data: {
                images: [{ url: inlinePng, content_type: "image/png" }],
                usage: {
                    total_tokens: 18,
                    input_tokens: 8,
                    output_tokens: 10,
                },
            },
            requestId: "fal-generation-1",
        }));
        const client = new FalImageGenerationClient({
            apiKey: "fal-test-key",
            subscribe,
        });

        const image = await client.generate({
            prompt: "A sparse paper poster",
            model: "gpt-image-2",
            size: "1600x1200",
            quality: "medium",
            outputFormat: "png",
        });

        expect(subscribe).toHaveBeenCalledOnce();
        expect(subscribe.mock.calls[0]?.[0]).toBe("openai/gpt-image-2");
        expect(subscribe.mock.calls[0]?.[1]?.input).toEqual({
            prompt: "A sparse paper poster",
            image_size: { width: 1600, height: 1200 },
            quality: "medium",
            num_images: 1,
            output_format: "png",
            sync_mode: true,
        });
        expect(subscribe.mock.calls[0]?.[1]?.abortSignal).toBeInstanceOf(
            AbortSignal,
        );
        expect(image).toMatchObject({
            bytes: minimalPng,
            mimeType: "image/png",
            outputFormat: "png",
            width: 1600,
            height: 1200,
            requestId: "fal-generation-1",
            usage: { totalTokens: 18, inputTokens: 8, outputTokens: 10 },
        });
    });

    it("edits one source raster through the FAL GPT Image 2 endpoint", async () => {
        const subscribe = vi.fn<FalSubscribe>(async () => ({
            data: { images: [{ url: inlinePng }] },
            requestId: "fal-edit-1",
        }));
        const client = new FalImageGenerationClient({
            apiKey: "fal-test-key",
            subscribe,
        });

        const image = await client.edit({
            image: {
                bytes: minimalPng,
                mimeType: "image/png",
                filename: "portrait.png",
            },
            prompt: "Rebuild this portrait as a CRT interface",
            model: "gpt-image-2",
            size: "1600x1200",
            quality: "low",
            outputFormat: "png",
        });

        expect(subscribe).toHaveBeenCalledOnce();
        expect(subscribe.mock.calls[0]?.[0]).toBe("openai/gpt-image-2/edit");
        expect(subscribe.mock.calls[0]?.[1]?.input).toEqual({
            prompt: "Rebuild this portrait as a CRT interface",
            image_urls: [
                `data:image/png;base64,${minimalPng.toString("base64")}`,
            ],
            image_size: { width: 1600, height: 1200 },
            quality: "low",
            num_images: 1,
            output_format: "png",
            sync_mode: true,
        });
        expect(image.requestId).toBe("fal-edit-1");
        expect(image.bytes).toEqual(minimalPng);
    });

    it("returns a typed sanitized dependency error", async () => {
        const dependencyError = Object.assign(
            new Error("prompt and fal-never-print-this-key"),
            {
                status: 429,
                requestId: "fal-request-2",
                code: "rate_limit",
            },
        );
        const client = new FalImageGenerationClient({
            apiKey: "fal-never-print-this-key",
            subscribe: vi.fn<FalSubscribe>().mockRejectedValue(dependencyError),
        });

        const error = await client
            .edit({
                image: { bytes: minimalPng, mimeType: "image/png" },
                prompt: "A private edit prompt",
            })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(FalImageGenerationError);
        expect(error).toMatchObject({
            status: 429,
            requestId: "fal-request-2",
            code: "rate_limit",
        });
        expect(String(error)).not.toContain("fal-never-print-this-key");
        expect(String(error)).not.toContain("private edit prompt");
    });

    it("rejects unsupported models and source-free edits before dispatch", async () => {
        const subscribe = vi.fn<FalSubscribe>();
        const client = new FalImageGenerationClient({
            apiKey: "fal-test-key",
            subscribe,
        });

        await expect(
            client.generate({ prompt: "A poster", model: "gpt-image-1" }),
        ).rejects.toThrow("supports only gpt-image-2");
        await expect(
            client.edit({
                image: { bytes: new Uint8Array(), mimeType: "image/png" },
                prompt: "Edit this image",
            }),
        ).rejects.toThrow("requires source image bytes");
        expect(subscribe).not.toHaveBeenCalled();
    });

    it("rejects non-raster inline output", async () => {
        const client = new FalImageGenerationClient({
            apiKey: "fal-test-key",
            subscribe: vi.fn<FalSubscribe>(async () => ({
                data: {
                    images: [
                        {
                            url: `data:image/png;base64,${Buffer.from("not-an-image").toString("base64")}`,
                        },
                    ],
                },
                requestId: "fal-request-3",
            })),
        });

        await expect(client.generate({ prompt: "A poster" })).rejects.toThrow(
            "not a supported raster image",
        );
    });
});
