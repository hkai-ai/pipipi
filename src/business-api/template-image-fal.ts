/** 固定 FAL 单图编辑协议，托管源图和恢复同一请求均不会新增生成提交。 */

import { setTimeout } from "node:timers/promises";
import { createFalClient } from "@fal-ai/client";
import type { ImageBackground } from "../processes/image-background.js";
import { sourcePhotoSchema } from "../processes/photo-poster/capability.js";
import { TemplateImagePreparationError } from "../processes/template-from-source/capability.js";
import { downloadSourcePhoto } from "./source-photo.js";

import { TemplateImageSubmissionError } from "./template-image-submission.js";

export function assertFalTemplateBackground(
    background?: ImageBackground | null,
) {
    if (background === "transparent")
        throw new TemplateImagePreparationError("unsupported_background");
}
export type TemplateImageRenderer = {
    host(bytes: Buffer, mimeType: string, signal: AbortSignal): Promise<string>;
    submit(
        url: string,
        prompt: string,
        size: string,
        signal: AbortSignal,
        background?: ImageBackground,
    ): Promise<string>;
    result(requestId: string, signal: AbortSignal): Promise<Buffer>;
};
export class TemplateImageResultError extends Error {
    readonly type = "provider_rejected";
    constructor(readonly httpStatus: number) {
        super("图片服务明确拒绝原请求");
    }
}
export function createTemplateImageRenderer(
    apiKey: string,
): TemplateImageRenderer {
    const endpoint = "openai/gpt-image-2/edit";
    async function query(
        requestId: string,
        suffix: string,
        signal: AbortSignal,
    ) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
            throw new Error("供应商请求标识无效");
        const response = await fetch(
            `https://queue.fal.run/openai/gpt-image-2/requests/${requestId}${suffix}`,
            {
                headers: { authorization: `Key ${apiKey}` },
                signal,
                redirect: "error",
            },
        );
        if (!response.ok) {
            await response.body?.cancel();
            // 只有完成后的结果校验拒绝能证明生成失败；鉴权/查询错误仍可恢复。
            if (suffix === "" && [400, 422].includes(response.status))
                throw new TemplateImageResultError(response.status);
            throw new Error("图片状态查询未完成，请恢复原请求");
        }
        return response.json();
    }
    return {
        async host(bytes, mimeType, signal) {
            // SDK 上传没有信号参数；每次托管独享带信号的 transport，避免并发串用。
            const storageClient = createFalClient({
                credentials: apiKey,
                retry: { maxRetries: 0 },
                fetch: (input, init) => {
                    signal.throwIfAborted();
                    return fetch(input, { ...init, signal, redirect: "error" });
                },
            });
            for (let attempt = 0; ; attempt++) {
                signal.throwIfAborted();
                try {
                    const url = await storageClient.storage.upload(
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
        async submit(url, prompt, size, signal, background) {
            assertFalTemplateBackground(background);
            signal.throwIfAborted();
            const [width, height] = size.split("x").map(Number);
            try {
                const response = await fetch(
                    `https://queue.fal.run/${endpoint}`,
                    {
                        method: "POST",
                        redirect: "error",
                        signal,
                        headers: {
                            authorization: `Key ${apiKey}`,
                            "content-type": "application/json",
                        },
                        body: JSON.stringify({
                            prompt,
                            image_urls: [url],
                            image_size: { width, height },
                            ...(background ? { background } : {}),
                            quality: "low",
                            num_images: 1,
                            output_format: "png",
                        }),
                    },
                );
                if (!response.ok) {
                    await response.body?.cancel();
                    throw TemplateImageSubmissionError.fromStatus(
                        response.status,
                    );
                }
                const result = (await response.json()) as {
                    request_id?: unknown;
                };
                if (
                    typeof result.request_id !== "string" ||
                    !/^[A-Za-z0-9_-]{1,128}$/.test(result.request_id)
                )
                    throw new TemplateImageSubmissionError(
                        "submission_unknown",
                    );
                return result.request_id;
            } catch (error) {
                if (error instanceof TemplateImageSubmissionError) throw error;
                throw new TemplateImageSubmissionError("submission_unknown");
            }
        },
        async result(requestId, signal) {
            while (true) {
                signal.throwIfAborted();
                const status = (await query(
                    requestId,
                    "/status?logs=0",
                    signal,
                )) as { status?: string };
                if (status.status === "COMPLETED") break;
                await setTimeout(2000, undefined, { signal });
            }
            const value = (await query(requestId, "", signal)) as {
                images?: { url?: string }[];
            };
            if (value.images?.length !== 1) throw new Error("生成产物不是单图");
            return downloadSourcePhoto(
                sourcePhotoSchema.parse(value.images[0].url),
                signal,
            );
        },
    };
}
