import { describe, expect, it, vi } from "vitest";
import { CrtRenderingUnavailable } from "../src/processes/crt/capability.js";
import { HttpCrtRenderingCapability } from "../src/processes/crt/http.js";

const image = {
    url: "https://assets.example/crt/run-1.png",
    contentType: "image/png" as const,
    width: 1_600,
    height: 1_200,
    expiresAt: "2026-08-10T12:00:00.000Z",
};

describe("CRT Rendering HTTP Adapter", () => {
    it("calls the owned API with the run id and validates its image reference", async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(JSON.stringify(image)));
        const capability = new HttpCrtRenderingCapability({
            baseUrl: "https://business.example/base/",
            fetch: fetchMock,
        });

        const result = await capability.transform(
            {
                sourceImageUrl: "https://images.example.com/portrait-01.png",
                prompt: "Transform the attached image",
                palette: "经典",
                aspectRatio: "4:3",
            },
            {
                signal: new AbortController().signal,
                idempotencyKey: "run-1",
            },
        );

        expect(result).toEqual(image);
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, request] = fetchMock.mock.calls[0] ?? [];
        expect(String(url)).toBe("https://business.example/crt-images");
        expect(request?.method).toBe("POST");
        expect(request?.headers).toEqual({
            "content-type": "application/json",
            "idempotency-key": "run-1",
        });
        expect(JSON.parse(String(request?.body))).toEqual({
            sourceImageUrl: "https://images.example.com/portrait-01.png",
            prompt: "Transform the attached image",
            palette: "经典",
            aspectRatio: "4:3",
        });
    });

    it("hides remote errors and rejects malformed raster metadata", async () => {
        const capability = new HttpCrtRenderingCapability({
            baseUrl: "https://business.example",
            fetch: vi.fn<typeof fetch>().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        ...image,
                        contentType: "image/jpeg",
                    }),
                ),
            ),
        });

        const error = await capability
            .transform(
                {
                    sourceImageUrl:
                        "https://images.example.com/portrait-01.png",
                    prompt: "Transform the attached image",
                    palette: "经典",
                    aspectRatio: "4:3",
                },
                {
                    signal: new AbortController().signal,
                    idempotencyKey: "run-1",
                },
            )
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(CrtRenderingUnavailable);
        expect(String(error)).not.toContain("image/jpeg");
    });

    it("validates its timeout at construction", () => {
        expect(
            () =>
                new HttpCrtRenderingCapability({
                    baseUrl: "https://business.example",
                    timeoutMs: 0,
                }),
        ).toThrow("CRT API timeout must be a positive integer");
    });
});
