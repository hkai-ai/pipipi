import {
    type NewsImageRenderingCapability,
    type NewsImageRenderingResult,
    NewsImageRenderingUnavailable,
    parseNewsImageRenderingResult,
} from "./capability.js";

export class HttpNewsImageRenderingCapability
    implements NewsImageRenderingCapability
{
    readonly #endpoint: URL;
    readonly #timeoutMs: number;
    readonly #fetch: typeof globalThis.fetch;

    constructor(options: {
        baseUrl: string;
        timeoutMs?: number;
        fetch?: typeof globalThis.fetch;
    }) {
        this.#endpoint = new URL("/news-images", options.baseUrl);
        this.#timeoutMs = options.timeoutMs ?? 180_000;
        if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
            throw new Error(
                "News image API timeout must be a positive integer",
            );
        }
        this.#fetch = options.fetch ?? globalThis.fetch;
    }

    async render(
        input: {
            prompt: string;
            aspectRatio: "4:3";
            style: "narrative-monument" | "pale-watercolor" | "raw-humanism";
        },
        options: { signal: AbortSignal; idempotencyKey: string },
    ): Promise<NewsImageRenderingResult> {
        try {
            const response = await this.#fetch(this.#endpoint, {
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
                throw new Error("News image API returned an error");
            }
            return parseNewsImageRenderingResult(await response.json());
        } catch (error) {
            throw new NewsImageRenderingUnavailable({ cause: error });
        }
    }
}
