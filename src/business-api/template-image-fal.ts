/** 固定 FAL 单图编辑协议，托管源图和恢复同一请求均不会新增生成提交。 */

import { setTimeout } from "node:timers/promises";
import { createFalClient } from "@fal-ai/client";
import { sourcePhotoSchema } from "../processes/photo-poster/capability.js";
import { downloadSourcePhoto } from "./source-photo.js";
export type TemplateImageRenderer = {
    host(bytes: Buffer, mimeType: string, signal: AbortSignal): Promise<string>;
    submit(
        url: string,
        prompt: string,
        size: string,
        signal: AbortSignal,
    ): Promise<string>;
    result(requestId: string, signal: AbortSignal): Promise<Buffer>;
};
export function createTemplateImageRenderer(
    apiKey: string,
): TemplateImageRenderer {
    const client = createFalClient({
        credentials: apiKey,
        retry: { maxRetries: 0 },
    });
    const endpoint = "openai/gpt-image-2/edit";
    return {
        async host(bytes, mimeType, signal) {
            for (let attempt = 0; ; attempt++) {
                signal.throwIfAborted();
                try {
                    const url = await client.storage.upload(
                        new Blob([new Uint8Array(bytes)], { type: mimeType }),
                        { lifecycle: { expiresIn: "1d" } },
                    );
                    signal.throwIfAborted();
                    return sourcePhotoSchema.parse(url);
                } catch {
                    signal.throwIfAborted();
                    if (attempt === 2)
                        throw new Error("源图托管失败，未提交生成");
                    await setTimeout((attempt + 1) * 5000, undefined, {
                        signal,
                    });
                }
            }
        },
        async submit(url, prompt, size, signal) {
            signal.throwIfAborted();
            const [width, height] = size.split("x").map(Number);
            const result = await client.queue.submit(endpoint, {
                input: {
                    prompt,
                    image_urls: [url],
                    image_size: { width, height },
                    quality: "low",
                    num_images: 1,
                    output_format: "png",
                },
                abortSignal: signal,
            });
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(result.request_id))
                throw new Error("生成提交未返回有效标识");
            return result.request_id;
        },
        async result(requestId, signal) {
            while (true) {
                signal.throwIfAborted();
                const status = await client.queue.status(endpoint, {
                    requestId,
                    logs: false,
                });
                if (status.status === "COMPLETED") break;
                await setTimeout(2000, undefined, { signal });
            }
            const result = await client.queue.result(endpoint, { requestId });
            const value = result.data as { images?: { url?: string }[] };
            if (value.images?.length !== 1) throw new Error("生成产物不是单图");
            return downloadSourcePhoto(
                sourcePhotoSchema.parse(value.images[0].url),
                signal,
            );
        },
    };
}
