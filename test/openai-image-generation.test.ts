import { describe, expect, it, vi } from "vitest";
import {
    OpenAIImageGenerationClient,
    OpenAIImageGenerationError,
} from "../examples/support/openai-image-generation.js";

const minimalPng = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    Buffer.from("00000400000006a0", "hex"),
]);

describe("OpenAI image generation Adapter", () => {
    it("calls the configured Images API and decodes its first raster image", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [{ b64_json: minimalPng.toString("base64") }],
                    usage: {
                        total_tokens: 12,
                        input_tokens: 5,
                        output_tokens: 7,
                    },
                }),
                {
                    status: 200,
                    headers: { "x-request-id": "image-request-1" },
                },
            ),
        );
        const client = new OpenAIImageGenerationClient({
            apiKey: "test-key",
            baseUrl: "https://gateway.example/v1/",
            fetch: fetchMock,
        });

        const image = await client.generate({
            prompt: "A sparse paper poster",
            model: "gpt-image-2",
            size: "1024x1696",
            quality: "low",
        });

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, request] = fetchMock.mock.calls[0] ?? [];
        expect(url).toBe("https://gateway.example/v1/images/generations");
        expect(request?.headers).toEqual({
            authorization: "Bearer test-key",
            "content-type": "application/json",
        });
        expect(JSON.parse(String(request?.body))).toEqual({
            model: "gpt-image-2",
            prompt: "A sparse paper poster",
            n: 1,
            size: "1024x1696",
            quality: "low",
            output_format: "png",
        });
        expect(image).toMatchObject({
            bytes: minimalPng,
            mimeType: "image/png",
            outputFormat: "png",
            width: 1024,
            height: 1696,
            requestId: "image-request-1",
            usage: { totalTokens: 12, inputTokens: 5, outputTokens: 7 },
        });
    });

    it("returns a typed error without exposing the API key", async () => {
        const client = new OpenAIImageGenerationClient({
            apiKey: "never-print-this-key",
            fetch: vi.fn<typeof fetch>().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        error: {
                            code: "model_not_found",
                            message: "Unknown model",
                        },
                    }),
                    {
                        status: 404,
                        headers: { "x-request-id": "image-request-2" },
                    },
                ),
            ),
        });

        const error = await client
            .generate({ prompt: "A poster" })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(OpenAIImageGenerationError);
        expect(error).toMatchObject({
            status: 404,
            requestId: "image-request-2",
            code: "model_not_found",
        });
        expect(String(error)).not.toContain("never-print-this-key");
    });

    it("rejects successful responses that contain no raster image", async () => {
        const client = new OpenAIImageGenerationClient({
            apiKey: "test-key",
            fetch: vi.fn<typeof fetch>().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        data: [{ b64_json: "bm90LWltYWdl" }],
                    }),
                ),
            ),
        });

        await expect(client.generate({ prompt: "A poster" })).rejects.toThrow(
            "not a supported raster image",
        );
    });
});
