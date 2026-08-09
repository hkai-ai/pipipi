import { describe, expect, it, vi } from "vitest";
import { PosterRenderingUnavailable } from "../src/processes/poster/capability.js";
import { HttpPosterRenderingCapability } from "../src/processes/poster/http.js";

const image = {
    url: "https://assets.example/posters/poster-1.webp",
    contentType: "image/webp" as const,
    width: 1_024,
    height: 1_696,
    expiresAt: "2026-08-10T12:00:00.000Z",
};

describe("Poster Rendering HTTP Adapter", () => {
    it("calls the owned API with the run id and validates its image reference", async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(JSON.stringify(image)));
        const capability = new HttpPosterRenderingCapability({
            baseUrl: "https://business.example/base/",
            fetch: fetchMock,
        });

        const result = await capability.render(
            { prompt: "A sparse paper poster", aspectRatio: "3:5" },
            {
                signal: new AbortController().signal,
                idempotencyKey: "run-1",
            },
        );

        expect(result).toEqual(image);
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, request] = fetchMock.mock.calls[0] ?? [];
        expect(String(url)).toBe("https://business.example/posters");
        expect(request?.method).toBe("POST");
        expect(request?.headers).toEqual({
            "content-type": "application/json",
            "idempotency-key": "run-1",
        });
        expect(JSON.parse(String(request?.body))).toEqual({
            prompt: "A sparse paper poster",
            aspectRatio: "3:5",
        });
    });

    it("hides remote errors and rejects unsafe image references", async () => {
        const capability = new HttpPosterRenderingCapability({
            baseUrl: "https://business.example",
            fetch: vi.fn<typeof fetch>().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        ...image,
                        url: "https://user:secret@assets.example/poster.webp",
                    }),
                ),
            ),
        });

        const error = await capability
            .render(
                { prompt: "A sparse paper poster", aspectRatio: "3:5" },
                {
                    signal: new AbortController().signal,
                    idempotencyKey: "run-1",
                },
            )
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(PosterRenderingUnavailable);
        expect(String(error)).not.toContain("secret");
    });

    it("validates its timeout at construction", () => {
        expect(
            () =>
                new HttpPosterRenderingCapability({
                    baseUrl: "https://business.example",
                    timeoutMs: 0,
                }),
        ).toThrow("Poster API timeout must be a positive integer");
    });
});
