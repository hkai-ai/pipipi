/** 通过真实内部 HTTP 和磁盘记录核对 v4 只恢复同一付费生成。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { createCharacterEmojiImageClient } from "../src/business-api/character-emoji-image.js";
import { startCrtBusinessApi } from "../src/business-api/crt-server.js";
import { HttpCharacterEmojiRenderingCapability } from "../src/processes/character-emoji/capability.http.js";
import contract from "./fixtures/character-emoji-v4.json" with { type: "json" };

const input = {
    prompt: "雨狐举起自己的雨伞。".repeat(20),
    imageUrls: [contract.single.request.input.cast[0].referenceImageUrl],
    size: "1024x1024",
};
const key = "run-36";
const headers = { "idempotency-key": key, "content-type": "application/json" };
it.each(["lost-primary", "lost-service-response", "saved-job"])(
    "v4 图片 %s 按原键恢复并核对渠道提交次数",
    async (outcome) => {
        const directory = await mkdtemp(join(tmpdir(), "emoji-recovery-"));
        const png = await sharp({
            create: { width: 64, height: 64, channels: 4, background: "white" },
        })
            .png()
            .toBuffer();
        let primaryPosts = 0;
        let backupPosts = 0;
        let polls = 0;
        const provider = vi.fn<typeof fetch>(async (url, init) => {
            if (String(url) === input.imageUrls[0]) return new Response(png);
            if (String(url).endsWith("/images/edits")) {
                primaryPosts++;
                expect(new Headers(init?.headers).get("idempotency-key")).toBe(
                    key,
                );
                if (outcome === "lost-primary")
                    throw new TypeError("fetch failed");
                if (outcome === "saved-job")
                    return new Response(null, { status: 401 });
                return Response.json({
                    data: [{ b64_json: png.toString("base64") }],
                });
            }
            if (String(url).endsWith("/v1/jobs")) {
                backupPosts++;
                return Response.json(
                    {
                        jobId: "original",
                        deadlineAt: "2026-01-01T00:00:00.000Z",
                    },
                    { status: 202 },
                );
            }
            if (String(url).endsWith("/v1/jobs/original")) {
                polls++;
                // 模拟首次轮询响应损坏，重启后的查询可读回同一 Job。
                if (polls === 1) return new Response("invalid");
                return Response.json({
                    jobId: "original",
                    status: "succeeded",
                    outputs: [
                        {
                            mediaType: "image",
                            mimeType: "image/png",
                            url: "https://cdn.example/result.png",
                        },
                    ],
                });
            }
            if (String(url) === "https://cdn.example/result.png")
                return new Response(png);
            throw new Error("意外的渠道请求");
        });
        const start = () => {
            const client = createCharacterEmojiImageClient(
                {
                    CHARACTER_EMOJI_IMAGE_API_KEY: "test",
                    CHARACTER_EMOJI_IMAGE_BASE_URL: "https://primary.example",
                    MAGIKARU_API_KEY: "test",
                    MAGIKARU_BASE_URL: "https://backup.example",
                },
                { directory, fetch: provider },
            );
            if (!client) throw new Error("未装配图片客户端");
            return startCrtBusinessApi(
                {
                    directory,
                    imageClient: client,
                    characterEmojiImageClient: client,
                },
                { port: 0 },
            );
        };
        let api = await start();
        const http = globalThis.fetch;
        const lookup = () =>
            http(`${api.url}/character-emojis/v4/result`, { headers });
        try {
            if (outcome === "saved-job") {
                expect(
                    (
                        await http(`${api.url}/character-emojis/v4`, {
                            method: "POST",
                            headers,
                            body: JSON.stringify(input),
                        })
                    ).status,
                ).toBe(503);
                await api.close();
                api = await start();
                const response = await lookup();
                expect(response.status).toBe(200);
                expect(
                    Buffer.from(
                        await (
                            await http((await response.json()).url)
                        ).arrayBuffer(),
                    ),
                ).toEqual(png);
                expect(polls).toBe(2);
            } else {
                const transport = vi
                    .spyOn(globalThis, "fetch")
                    .mockImplementation(async (url, init) => {
                        const response = await http(url, init);
                        if (
                            init?.method === "POST" &&
                            outcome === "lost-service-response"
                        ) {
                            expect(response.status).toBe(200);
                            await response.body?.cancel();
                            throw new TypeError("fetch failed");
                        }
                        return response;
                    });
                const capability = new HttpCharacterEmojiRenderingCapability({
                    baseUrl: api.url,
                    recoverable: true,
                    timeoutMs: 5000,
                });
                const result = capability.render(input, {
                    idempotencyKey: key,
                    signal: AbortSignal.timeout(5000),
                });
                if (outcome === "lost-primary") {
                    await expect(result).rejects.toMatchObject({
                        committed: true,
                    });
                    expect((await lookup()).status).toBe(503);
                } else {
                    const image = await result;
                    expect(
                        Buffer.from(
                            await (await http(image.url)).arrayBuffer(),
                        ),
                    ).toEqual(png);
                }
                expect(
                    transport.mock.calls.map(
                        ([url]) => new URL(String(url)).pathname,
                    ),
                ).toEqual([
                    "/character-emojis/v4",
                    "/character-emojis/v4/result",
                ]);
            }
            expect(primaryPosts).toBe(1);
            expect(backupPosts).toBe(outcome === "saved-job" ? 1 : 0);
        } finally {
            vi.restoreAllMocks();
            await api.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

it("原图正在生成时只查询，完成后凭原键交付；不同输入摘要拒绝读取", async () => {
    const directory = await mkdtemp(join(tmpdir(), "emoji-pending-"));
    const started = deferred();
    const finish = deferred();
    const bytes = await sharp({
        create: { width: 64, height: 64, channels: 4, background: "black" },
    })
        .png()
        .toBuffer();
    const edit = vi.fn(async () => {
        started.resolve();
        await finish.promise;
        return { bytes, mimeType: "image/png", outputFormat: "png" as const };
    });
    const api = await startCrtBusinessApi(
        {
            directory,
            imageClient: { edit },
            characterEmojiImageClient: { edit },
        },
        { port: 0 },
    );
    const http = globalThis.fetch;
    const transport = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url, init) => {
            const response = await http(url, init);
            if (init?.method !== "POST" && response.status === 202)
                finish.resolve();
            return response;
        });
    try {
        const first = http(`${api.url}/character-emojis/v4`, {
            method: "POST",
            headers,
            body: JSON.stringify(input),
        });
        await started.promise;
        const capability = new HttpCharacterEmojiRenderingCapability({
            baseUrl: api.url,
            recoverable: true,
            timeoutMs: 5000,
        });
        const result = await capability.render(input, {
            idempotencyKey: key,
            signal: AbortSignal.timeout(5000),
        });
        expect(await (await first).json()).toEqual(result);
        const methods = transport.mock.calls.map(
            ([, init]) => init?.method ?? "GET",
        );
        expect(methods[0]).toBe("POST");
        expect(methods.length).toBeGreaterThanOrEqual(3);
        expect(methods.slice(1).every((method) => method === "GET")).toBe(true);
        const mismatch = await http(`${api.url}/character-emojis/v4/result`, {
            headers: { ...headers, "x-input-sha256": "0".repeat(64) },
        });
        expect(mismatch.status).toBe(409);
        expect(edit).toHaveBeenCalledTimes(1);
    } finally {
        finish.resolve();
        transport.mockRestore();
        await api.close();
        await rm(directory, { recursive: true, force: true });
    }
});

function deferred() {
    let resolve = () => {};
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}
