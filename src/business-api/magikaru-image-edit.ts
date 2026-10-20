/** 通过 Magikaru External Job 提交一次角色图片编辑、保存任务身份并轮询下载结果。 */
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { characterEmojiRenderInputSchema } from "../processes/character-emoji/capability.js";
import {
    detectRasterImage,
    type EditImageRequest,
    type GeneratedImage,
} from "./openai-image-generation.js";

export const characterEmojiImageModel = "gpt-image-2.5";
const receiptSchema = z.object({
    jobId: z.string().min(1).max(128),
    deadlineAt: z.iso.datetime(),
});
export type MagikaruReceipt = z.infer<typeof receiptSchema> & {
    idempotencyKey: string;
};
const snapshotSchema = z.object({
    jobId: z.string(),
    status: z.enum(["pending", "succeeded", "failed"]),
    outputs: z
        .array(
            z.object({
                mediaType: z.string(),
                mimeType: z.string(),
                url: z.url(),
            }),
        )
        .optional(),
});

export class MagikaruImageEditError extends Error {
    constructor(
        readonly code: string,
        readonly jobId?: string,
        readonly status?: number,
    ) {
        super("Magikaru 图片编辑未完成");
        this.name = "MagikaruImageEditError";
    }
}

export class MagikaruImageEditClient {
    readonly #baseUrl: string;
    readonly #apiKey: string;
    readonly #fetch: typeof globalThis.fetch;
    readonly #timeoutMs: number;
    readonly #pollIntervalMs: number;
    readonly #onSubmitted: (receipt: MagikaruReceipt) => Promise<void>;

    constructor(options: {
        baseUrl: string;
        apiKey: string;
        fetch?: typeof globalThis.fetch;
        timeoutMs?: number;
        pollIntervalMs?: number;
        onSubmitted: (receipt: MagikaruReceipt) => Promise<void>;
    }) {
        const url = new URL(options.baseUrl);
        if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== "/"
        ) {
            throw new Error("MAGIKARU_BASE_URL 必须是 HTTPS Origin");
        }
        if (!options.apiKey.trim()) throw new Error("MAGIKARU_API_KEY 未配置");
        this.#baseUrl = url.origin;
        this.#apiKey = options.apiKey.trim();
        this.#fetch = options.fetch ?? globalThis.fetch;
        this.#timeoutMs = options.timeoutMs ?? 300_000;
        this.#pollIntervalMs = options.pollIntervalMs ?? 3_000;
        this.#onSubmitted = options.onSubmitted;
    }

    async edit(request: EditImageRequest): Promise<GeneratedImage> {
        const input = characterEmojiRenderInputSchema.parse({
            prompt: request.prompt,
            imageUrls: request.imageUrls,
            size: request.size,
        });
        const key = request.idempotencyKey;
        if (
            !key ||
            !/^[A-Za-z0-9_-]{1,128}$/u.test(key) ||
            request.model !== characterEmojiImageModel
        ) {
            throw new Error("Magikaru 图片编辑需要固定模型和有效幂等键");
        }
        const signal = AbortSignal.any([
            AbortSignal.timeout(this.#timeoutMs),
            ...(request.signal ? [request.signal] : []),
        ]);
        const headers = { authorization: `Bearer ${this.#apiKey}` };
        // POST 仅发送一次；提交未知时由本地 pending 记录阻止再次付费。
        const submitted = await this.#fetch(`${this.#baseUrl}/v1/jobs`, {
            method: "POST",
            redirect: "error",
            headers: {
                ...headers,
                "content-type": "application/json",
                "idempotency-key": key,
            },
            body: JSON.stringify({
                toolKey: characterEmojiImageModel,
                modality: "image",
                input: {
                    prompt: input.prompt,
                    size: input.size,
                    n: 1,
                    quality: request.quality ?? "low",
                    output_format: "png",
                    images: input.imageUrls.map((url, index) => ({
                        url,
                        identity: {
                            kind: "immutable_asset",
                            assetId: new URL(url).pathname.slice(1),
                        },
                        role: "reference",
                        slotKey: `character_reference_${index + 1}`,
                    })),
                },
                traceId: key,
                businessTaskId: key,
                context: { stageKey: "maker.ai_character_emoji_image" },
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        if (submitted.status !== 202)
            throw new MagikaruImageEditError(
                "SUBMIT_REJECTED",
                undefined,
                submitted.status,
            );
        const receipt = receiptSchema.parse(await submitted.json());
        await this.#onSubmitted({ ...receipt, idempotencyKey: key });
        return this.resume(receipt, signal);
    }

    async resume(
        saved: z.infer<typeof receiptSchema>,
        signal = AbortSignal.timeout(this.#timeoutMs),
    ): Promise<GeneratedImage> {
        const receipt = receiptSchema.parse(saved);
        const headers = { authorization: `Bearer ${this.#apiKey}` };
        // 截止时间约束生成；已成功的任务在截止后仍可查询并下载。
        const pollingSignal = signal;
        while (true) {
            pollingSignal.throwIfAborted();
            let response: Response;
            try {
                response = await this.#fetch(
                    `${this.#baseUrl}/v1/jobs/${encodeURIComponent(receipt.jobId)}`,
                    {
                        headers,
                        redirect: "error",
                        signal: AbortSignal.any([
                            pollingSignal,
                            AbortSignal.timeout(30_000),
                        ]),
                    },
                );
            } catch {
                pollingSignal.throwIfAborted();
                await delay(this.#pollIntervalMs, undefined, {
                    signal: pollingSignal,
                });
                continue;
            }
            if (
                [408, 425, 429].includes(response.status) ||
                response.status >= 500
            ) {
                const retryAfter = Number(response.headers.get("retry-after"));
                await delay(
                    Math.max(
                        this.#pollIntervalMs,
                        Number.isFinite(retryAfter)
                            ? Math.min(retryAfter * 1000, 60_000)
                            : 0,
                    ),
                    undefined,
                    { signal: pollingSignal },
                );
                continue;
            }
            if (!response.ok)
                throw new MagikaruImageEditError(
                    "POLL_REJECTED",
                    receipt.jobId,
                    response.status,
                );
            const snapshot = snapshotSchema.parse(await response.json());
            if (snapshot.jobId !== receipt.jobId)
                throw new MagikaruImageEditError(
                    "JOB_ID_MISMATCH",
                    receipt.jobId,
                );
            if (snapshot.status === "failed")
                throw new MagikaruImageEditError("JOB_FAILED", receipt.jobId);
            if (snapshot.status === "succeeded") {
                const output = snapshot.outputs?.[0];
                if (
                    snapshot.outputs?.length !== 1 ||
                    output?.mediaType !== "image" ||
                    output.mimeType !== "image/png"
                ) {
                    throw new MagikaruImageEditError(
                        "OUTPUT_INVALID",
                        receipt.jobId,
                    );
                }
                // 结果下载不携带 Gateway 凭证，并限制响应体大小。
                const image = await this.#download(
                    output.url,
                    pollingSignal,
                    receipt.jobId,
                );
                if (!image.ok || !image.body)
                    throw new MagikaruImageEditError(
                        "DOWNLOAD_FAILED",
                        receipt.jobId,
                    );
                const reader = image.body.getReader();
                const chunks: Uint8Array[] = [];
                let length = 0;
                while (true) {
                    const part = await reader.read();
                    if (part.done) break;
                    length += part.value.byteLength;
                    if (length > 32 * 1024 * 1024) {
                        await reader.cancel();
                        throw new MagikaruImageEditError(
                            "OUTPUT_TOO_LARGE",
                            receipt.jobId,
                        );
                    }
                    chunks.push(part.value);
                }
                const bytes = Buffer.concat(chunks);
                const raster = detectRasterImage(bytes);
                if (raster?.mimeType !== "image/png")
                    throw new MagikaruImageEditError(
                        "OUTPUT_INVALID",
                        receipt.jobId,
                    );
                return {
                    bytes,
                    ...raster,
                    outputFormat: "png",
                    requestId: receipt.jobId,
                };
            }
            const remaining = Date.parse(receipt.deadlineAt) - Date.now();
            if (remaining <= 0)
                throw new MagikaruImageEditError("JOB_DEADLINE", receipt.jobId);
            await delay(Math.min(this.#pollIntervalMs, remaining), undefined, {
                signal: pollingSignal,
            });
        }
    }

    async #download(
        source: string,
        signal: AbortSignal,
        jobId: string,
    ): Promise<Response> {
        let url = new URL(source);
        for (let redirects = 0; redirects <= 3; redirects += 1) {
            if (url.protocol !== "https:" || url.username || url.password)
                throw new MagikaruImageEditError("OUTPUT_URL_INVALID", jobId);
            const response = await this.#fetch(url, {
                redirect: "manual",
                signal,
            });
            if (![301, 302, 303, 307, 308].includes(response.status))
                return response;
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location) break;
            url = new URL(location, url);
        }
        throw new MagikaruImageEditError("OUTPUT_REDIRECT_LIMIT", jobId);
    }
}
