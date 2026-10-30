import { describe, expect, it, vi } from "vitest";
import {
    characterEmojiImageModel,
    MagikaruImageEditClient,
} from "../src/business-api/magikaru-image-edit.js";
import { imageUrl } from "../src/processes/character-emoji/catalog.js";

const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    Buffer.from("0000040000000400", "hex"),
]);
const input = {
    prompt: "角色参考图按顺序保留主体外观，制作双角色的方形表情包。".repeat(8),
    imageUrls: [imageUrl("DeepSeek", "Chibi"), imageUrl("Claude", "Chibi")],
    size: "1024x1024",
    model: characterEmojiImageModel,
    idempotencyKey: "run-1",
} as const;
const receipt = () => ({
    jobId: "job-1",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
});
const completed = () =>
    Response.json({
        jobId: "job-1",
        status: "succeeded",
        outputs: [
            {
                mediaType: "image",
                mimeType: "image/png",
                url: "https://gateway.example/media/result.png",
            },
        ],
    });

describe("Magikaru 角色图片编辑", () => {
    it("保持多图顺序与身份，先保存回执，轮询限流不重投，下载重定向不携带凭证", async () => {
        const events: string[] = [];
        const saved = vi.fn(async () => {
            events.push("saved");
        });
        let polls = 0;
        const fetcher = vi.fn<typeof fetch>(async (url, init) => {
            const target = String(url);
            if (init?.method === "POST") {
                events.push("submit");
                return Response.json(receipt(), { status: 202 });
            }
            if (target.endsWith("/v1/jobs/job-1")) {
                events.push("poll");
                if (++polls === 1)
                    return new Response(null, {
                        status: 429,
                        headers: { "retry-after": "0" },
                    });
                return completed();
            }
            expect(new Headers(init?.headers).has("authorization")).toBe(false);
            if (target.includes("/media/"))
                return new Response(null, {
                    status: 302,
                    headers: { location: "https://cdn.example/result.png" },
                });
            return new Response(png);
        });
        const client = new MagikaruImageEditClient({
            baseUrl: "https://gateway.example",
            apiKey: "secret",
            fetch: fetcher,
            pollIntervalMs: 1,
            onSubmitted: saved,
        });
        const result = await client.edit(input);
        expect(events.slice(0, 3)).toEqual(["submit", "saved", "poll"]);
        const posts = fetcher.mock.calls.filter(
            ([, init]) => init?.method === "POST",
        );
        expect(posts).toHaveLength(1);
        const body = JSON.parse(String(posts[0]?.[1]?.body));
        expect(body.toolKey).toBe("gpt-image-2.5");
        expect(
            body.input.images.map((image: { url: string; slotKey: string }) => [
                image.url,
                image.slotKey,
            ]),
        ).toEqual(
            input.imageUrls.map((url, index) => [
                url,
                `character_reference_${index + 1}`,
            ]),
        );
        expect(body.input.images[0].identity.kind).toBe("immutable_asset");
        expect(result).toMatchObject({
            mimeType: "image/png",
            width: 1024,
            height: 1024,
            requestId: "job-1",
        });
        expect(result.bytes).toEqual(png);
    });

    it("提交结果未知时不重发 POST", async () => {
        const fetcher = vi.fn<typeof fetch>(async () => {
            throw new TypeError("network failure");
        });
        const saved = vi.fn(async () => {});
        const client = new MagikaruImageEditClient({
            baseUrl: "https://gateway.example",
            apiKey: "secret",
            fetch: fetcher,
            onSubmitted: saved,
        });
        await expect(client.edit(input)).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(saved).not.toHaveBeenCalled();
    });

    it("已知 Job 恢复只查询和下载，不创建新任务", async () => {
        const fetcher = vi.fn<typeof fetch>(async (url, init) => {
            expect(init?.method).not.toBe("POST");
            return String(url).includes("/v1/jobs/")
                ? completed()
                : new Response(png);
        });
        const saved = vi.fn(async () => {});
        const client = new MagikaruImageEditClient({
            baseUrl: "https://gateway.example",
            apiKey: "secret",
            fetch: fetcher,
            onSubmitted: saved,
        });
        expect(
            (
                await client.resume({
                    jobId: "job-1",
                    deadlineAt: "2020-01-01T00:00:00.000Z",
                })
            ).bytes,
        ).toEqual(png);
        expect(saved).not.toHaveBeenCalled();
    });

    it("拒绝媒体重定向降级到 HTTP", async () => {
        const fetcher = vi.fn<typeof fetch>(async (url) =>
            String(url).includes("/v1/jobs/")
                ? completed()
                : new Response(null, {
                      status: 302,
                      headers: { location: "http://cdn.example/result.png" },
                  }),
        );
        const client = new MagikaruImageEditClient({
            baseUrl: "https://gateway.example",
            apiKey: "secret",
            fetch: fetcher,
            onSubmitted: async () => {},
        });
        await expect(client.resume(receipt())).rejects.toMatchObject({
            code: "OUTPUT_URL_INVALID",
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
