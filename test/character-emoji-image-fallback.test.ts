/** 验证文件主用失败后备用保留原始 URL、参数与取消边界。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createCharacterEmojiImageClient } from "../src/business-api/character-emoji-image.js";
import { imageUrl } from "../src/processes/character-emoji/catalog.js";

describe("角色图片文件主用与 URL 备用", () => {
    it.each(
        ["http500", "reference", "cancel", "success"].flatMap((outcome) =>
            ["legacy", "shared"].map((config) => ({ outcome, config })),
        ),
    )(
        "主用结果 $outcome、配置 $config 时正确控制备用",
        async ({ outcome, config }) => {
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
                        "https://assets.memebuy.cn/maker/characters/community/scenes/rain-fox/ink-ad7bad7bad7bad7b.png",
                        imageUrl("DeepSeek", "Chibi"),
                    ],
                    size: "864x1536",
                    background: "transparent" as const,
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
                        expect(target).toBe(
                            config === "shared"
                                ? "https://shared.example/v1/images/edits"
                                : "https://primary.example/v1/images/edits",
                        );
                        expect(
                            new Headers(init?.headers).get("authorization"),
                        ).toBe(
                            config === "shared"
                                ? "Bearer shared-test"
                                : "Bearer primary-test",
                        );
                        const form = init?.body;
                        if (!(form instanceof FormData))
                            throw new Error("缺少文件表单");
                        expect(form.getAll("image[]")).toHaveLength(2);
                        expect(form.get("background")).toBe("transparent");
                        expect(form.get("size")).toBe("864x1536");
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
                            background: "transparent",
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
                        ...(config === "shared"
                            ? {
                                  MODEL_GATEWAY_API_KEY: "shared-test",
                                  MODEL_GATEWAY_BASE_URL:
                                      "https://shared.example/v1",
                                  CHARACTER_EMOJI_IMAGE_ENABLED: "true",
                              }
                            : {}),
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

it.each([undefined, "false"])(
    "共享凭证不改变 Magikaru-only，开关 %s",
    async (flag) => {
        const fetcher = vi.fn<typeof fetch>(async () =>
            Response.json({}, { status: 409 }),
        );
        const client = createCharacterEmojiImageClient(
            {
                MODEL_GATEWAY_BASE_URL: "https://shared.example/v1",
                MODEL_GATEWAY_API_KEY: "shared-key",
                MAGIKARU_API_KEY: "backup-key",
                MAGIKARU_BASE_URL: "https://backup.example",
                CHARACTER_EMOJI_IMAGE_ENABLED: flag,
            },
            { directory: tmpdir(), fetch: fetcher },
        );
        if (!client) throw new Error("Missing backup");
        await expect(
            client.edit({
                prompt: "synthetic".repeat(20),
                size: "864x1536",
                imageUrls: [imageUrl("Claude", "Chibi")],
                idempotencyKey: "backup-only",
            }),
        ).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(String(fetcher.mock.calls[0][0])).toBe(
            "https://backup.example/v1/jobs",
        );
        expect(
            new Headers(fetcher.mock.calls[0][1]?.headers).get("authorization"),
        ).toBe("Bearer backup-key");
    },
);
it("共享凭证且无已启用渠道时不创建图片客户端", () => {
    expect(
        createCharacterEmojiImageClient(
            {
                MODEL_GATEWAY_BASE_URL: "https://shared.example/v1",
                MODEL_GATEWAY_API_KEY: "shared-key",
            },
            { directory: tmpdir() },
        ),
    ).toBeUndefined();
});
