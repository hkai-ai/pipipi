import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { createNewsImageAcceptance } from "../src/release/news-image-acceptance.js";

const cases = {
    "news-image-narrative-monument": {
        style: "narrative-monument",
        runId: "00000000-0000-4000-8000-000000000001",
    },
    "news-image-pale-watercolor": {
        style: "pale-watercolor",
        runId: "00000000-0000-4000-8000-000000000002",
    },
    "news-image-raw-humanism": {
        style: "raw-humanism",
        runId: "00000000-0000-4000-8000-000000000003",
    },
} as const;

let png: Buffer;

beforeAll(async () => {
    png = await sharp({
        create: {
            width: 1_600,
            height: 1_200,
            channels: 3,
            background: "#f2eee4",
        },
    })
        .png()
        .toBuffer();
});

describe("news image Business Process acceptance", () => {
    it("runs every fixed Process once and returns URL-free evidence", async () => {
        const calls: Array<{ url: string; method: string }> = [];
        const result = await createNewsImageAcceptance({
            baseUrl: "http://127.0.0.1:4399/",
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/news-image/",
            timeoutMs: 1_000,
            fetch: createFetch(calls),
        }).run();

        expect(calls).toHaveLength(6);
        expect(calls.filter(({ method }) => method === "POST")).toHaveLength(3);
        expect(calls.filter(({ method }) => method === "GET")).toHaveLength(3);
        expect(result.processRuns).toHaveLength(3);
        expect(result.processRuns.map(({ process }) => process.id)).toEqual(
            Object.keys(cases),
        );
        expect(result.processRuns.map(({ style }) => style)).toEqual([
            "narrative-monument",
            "pale-watercolor",
            "raw-humanism",
        ]);
        expect(
            result.processRuns.every(({ object }) => object.accessible),
        ).toBe(true);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("signature=secret");
        expect(serialized).not.toContain("assets.example.com");
        expect(serialized).not.toMatch(/prompt|authorization|credential/iu);
    });

    it("rejects a Process output bound to the wrong fixed style", async () => {
        const fake = createFetch([], { wrongStyle: true });

        await expect(
            createNewsImageAcceptance({
                baseUrl: "http://127.0.0.1:4399/",
                expectedOssHost: "assets.example.com",
                expectedOssPathPrefix: "/news-image/",
                timeoutMs: 1_000,
                fetch: fake,
            }).run(),
        ).rejects.toThrow("Process result is invalid");
    });

    it("rejects redirects before downloading an approved OSS object", async () => {
        const fake = createFetch([], { redirectImage: true });

        await expect(
            createNewsImageAcceptance({
                baseUrl: "http://127.0.0.1:4399/",
                expectedOssHost: "assets.example.com",
                expectedOssPathPrefix: "/news-image/",
                timeoutMs: 1_000,
                fetch: fake,
            }).run(),
        ).rejects.toThrow("object is not accessible");
    });
});

function createFetch(
    calls: Array<{ url: string; method: string }>,
    options: { wrongStyle?: boolean; redirectImage?: boolean } = {},
): typeof fetch {
    return (async (input, init) => {
        const url = input instanceof URL ? input : new URL(String(input));
        const method = init?.method ?? "GET";
        calls.push({ url: url.toString(), method });
        if (method === "POST" && url.pathname === "/execute") {
            const request = JSON.parse(String(init?.body)) as {
                process: keyof typeof cases;
            };
            const testCase = cases[request.process];
            const style = options.wrongStyle ? "raw-humanism" : testCase.style;
            return Response.json({
                runId: testCase.runId,
                process: request.process,
                version: "v1",
                status: "succeeded",
                output: {
                    style,
                    image: {
                        url: `https://assets.example.com/news-image/${testCase.style}/${testCase.runId}.png?signature=secret`,
                        contentType: "image/png",
                        width: 1_600,
                        height: 1_200,
                    },
                },
            });
        }
        if (method === "GET" && url.hostname === "assets.example.com") {
            if (options.redirectImage) {
                return new Response(undefined, {
                    status: 302,
                    headers: { location: "https://other.example/image.png" },
                });
            }
            return new Response(new Uint8Array(png), {
                status: 200,
                headers: {
                    "content-type": "image/png",
                    "content-length": String(png.length),
                },
            });
        }
        return new Response(undefined, { status: 404 });
    }) as typeof fetch;
}
