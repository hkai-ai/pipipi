/** 通过内部 Business API 生成照片风格成品。 */
import {
    type PhotoPosterRenderInput,
    type PhotoPosterRenderingCapability,
    PhotoPosterRenderingUnavailable,
    photoPosterImageSchema,
} from "./capability.js";

export class HttpPhotoPosterRenderingCapability
    implements PhotoPosterRenderingCapability
{
    readonly #endpoint: URL;
    readonly #timeoutMs: number;
    constructor(options: { baseUrl: string; timeoutMs: number }) {
        this.#endpoint = new URL("/photo-posters", options.baseUrl);
        this.#timeoutMs = options.timeoutMs;
        if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1)
            throw new Error("照片海报超时必须为正整数");
    }
    async render(
        input: PhotoPosterRenderInput,
        options: { signal: AbortSignal; idempotencyKey: string },
    ) {
        // 请求发出后若失去响应，无法确认是否已扣费，保守阻止自动重试。
        try {
            const response = await fetch(this.#endpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": options.idempotencyKey,
                },
                body: JSON.stringify(input),
                signal: AbortSignal.any([
                    options.signal,
                    AbortSignal.timeout(this.#timeoutMs),
                ]),
            });
            if (!response.ok) {
                const value = (await response.json()) as {
                    error?: { code?: string };
                };
                throw new PhotoPosterRenderingUnavailable({
                    committed: value.error?.code !== "PHOTO_POSTER_REJECTED",
                });
            }
            return photoPosterImageSchema.parse(await response.json());
        } catch (error) {
            if (error instanceof PhotoPosterRenderingUnavailable) throw error;
            throw new PhotoPosterRenderingUnavailable({
                cause: error,
                committed: true,
            });
        }
    }
}
