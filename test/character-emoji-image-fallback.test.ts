/** 验证文件主用失败后备用保留原始 URL、参数与取消边界。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createCharacterEmojiImageClient } from "../src/business-api/character-emoji-image.js";
import { imageUrl } from "../src/processes/character-emoji/catalog.js";

describe("角色图片文件主用与 URL 备用", () => {
    it.each(["http500", "reference", "cancel", "success"])(
        "主用结果 %s 时正确控制备用",
        async (outcome) => {
            const directory = await mkdtemp(join(tmpdir(), "emoji-fallback-"));
            if (
                dirname(resolve(directory)) !== resolve(tmpdir()) ||
                !basename(directory).startsWith("emoji-fallback-")
            )
                throw new Error("测试目录不在预期临时目录内");
            try {
                const bytes = await sharp({
                    create: {
                        width: 32,
                        height: 32,
                        channels: 4,
                        background: "white",
                    },
                })
                    .png()
                    .toBuffer();
                const controller = new AbortController();
                const request = {
                    prompt: "按顺序保留角色参考图，用明确动作绘制表情包。".repeat(
                        8,
                    ),
                    imageUrls: [
                        imageUrl("Claude", "Chibi"),
                        imageUrl("DeepSeek", "Chibi"),
                    ],
                    size: "1024x1536",
                    quality: "low" as const,
                    idempotencyKey: "fallback-test",
                    signal: controller.signal,
                };
                const fetcher = vi.fn<typeof fetch>(async (url, init) => {
                    const target = String(url);
                    if (target.startsWith("https://assets.memebuy.cn/")) {
                        expect(
                            new Headers(init?.headers).has("authorization"),
                        ).toBe(false);
                        if (outcome === "reference")
                            return new Response(null, { status: 503 });
                        return new Response(bytes);
                    }
                    if (target.endsWith("/images/edits")) {
                        const form = init?.body;
                        if (!(form instanceof FormData))
                            throw new Error("缺少文件表单");
                        expect(form.getAll("image[]")).toHaveLength(2);
                        if (outcome === "success")
                            return Response.json({
                                data: [{ b64_json: bytes.toString("base64") }],
                            });
                        if (outcome === "cancel") controller.abort();
                        return Response.json({}, { status: 500 });
                    }
                    if (init?.method === "POST") {
                        const body = JSON.parse(String(init.body));
                        expect(
                            body.input.images.map(
                                (item: { url: string }) => item.url,
                            ),
                        ).toEqual(request.imageUrls);
                        expect(body.input).toMatchObject({
                            prompt: request.prompt,
                            size: request.size,
                            quality: request.quality,
                        });
                        return Response.json(
                            {
                                jobId: "job-1",
                                deadlineAt: new Date(
                                    Date.now() + 60_000,
                                ).toISOString(),
                            },
                            { status: 202 },
                        );
                    }
                    if (target.endsWith("/v1/jobs/job-1"))
                        return Response.json({
                            jobId: "job-1",
                            status: "succeeded",
                            outputs: [
                                {
                                    mediaType: "image",
                                    mimeType: "image/png",
                                    url: "https://cdn.example/result.png",
                                },
                            ],
                        });
                    return new Response(bytes);
                });
                const attempts = vi.fn();
                const client = createCharacterEmojiImageClient(
                    {
                        CHARACTER_EMOJI_IMAGE_API_KEY: "primary-test",
                        CHARACTER_EMOJI_IMAGE_BASE_URL:
                            "https://primary.example/v1",
                        MAGIKARU_API_KEY: "backup-test",
                        MAGIKARU_BASE_URL: "https://backup.example",
                    },
                    { directory, fetch: fetcher, onAttempts: attempts },
                );
                if (!client) throw new Error("图片客户端未创建");
                if (outcome === "cancel")
                    await expect(client.edit(request)).rejects.toThrow();
                else expect((await client.edit(request)).bytes).toEqual(bytes);
                const backupPosts = fetcher.mock.calls.filter(
                    ([url, init]) =>
                        String(url) === "https://backup.example/v1/jobs" &&
                        init?.method === "POST",
                );
                const fallback =
                    outcome === "http500" || outcome === "reference";
                expect(backupPosts).toHaveLength(fallback ? 1 : 0);
                expect(attempts.mock.calls[0][0].modelAttempts).toHaveLength(
                    fallback ? 2 : 1,
                );
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        },
    );
});
