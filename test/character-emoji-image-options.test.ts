import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { startCrtBusinessApi } from "../src/business-api/crt-server.js";
import type { EditImageRequest } from "../src/business-api/openai-image-generation.js";
import { imageUrl } from "../src/processes/character-emoji/catalog.js";

it("真实内部 HTTP 透传背景、保留 Alpha，并拒绝白底和全透明；参数变化产生幂等冲突", async () => {
    const directory = await mkdtemp(join(tmpdir(), "emoji-options-"));
    if (
        dirname(resolve(directory)) !== resolve(tmpdir()) ||
        !basename(directory).startsWith("emoji-options-")
    )
        throw new Error("无效测试目录");
    const pixels = Buffer.alloc(64 * 64 * 4, 255);
    pixels[3] = 0;
    let bytes = await sharp(pixels, {
        raw: { width: 64, height: 64, channels: 4 },
    })
        .png()
        .toBuffer();
    const edit = vi.fn(async (_request: EditImageRequest) => ({
        bytes,
        mimeType: "image/png" as const,
        outputFormat: "png" as const,
        width: 64,
        height: 64,
    }));
    const api = await startCrtBusinessApi(
        {
            directory,
            imageClient: { edit },
            characterEmojiImageClient: { edit },
        },
        { port: 0 },
    );
    const body = {
        prompt: "保留角色和关键道具，透明背景。".repeat(12),
        imageUrls: [imageUrl("Claude", "Girl", "v3")],
        size: "864x1536",
        background: "transparent",
    };
    const post = (key: string, input = body) =>
        fetch(`${api.url}/character-emojis`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": key,
            },
            body: JSON.stringify(input),
        });
    try {
        const response = await post("valid");
        expect(response.status).toBe(200);
        expect(edit.mock.calls[0]?.[0]).toMatchObject({
            background: "transparent",
            size: "864x1536",
        });
        const result = await response.json();
        const downloaded = Buffer.from(
            await (await fetch(result.url)).arrayBuffer(),
        );
        expect((await sharp(downloaded).stats()).isOpaque).toBe(false);
        expect(
            (await post("valid", { ...body, background: "opaque" })).status,
        ).toBe(409);
        expect(edit).toHaveBeenCalledTimes(1);
        bytes = await sharp({
            create: { width: 64, height: 64, channels: 4, background: "white" },
        })
            .png()
            .toBuffer();
        expect((await post("white")).status).toBe(503);
        bytes = await sharp({
            create: {
                width: 64,
                height: 64,
                channels: 4,
                background: "#00000000",
            },
        })
            .png()
            .toBuffer();
        expect((await post("blank")).status).toBe(503);
        expect(edit).toHaveBeenCalledTimes(3);
    } finally {
        await api.close();
        await rm(directory, { recursive: true, force: true });
    }
});
