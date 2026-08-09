import {
    type PosterImage,
    type PosterRenderingCapability,
    PosterRenderingUnavailable,
    parsePosterImage,
} from "./capability.js";

export class HttpPosterRenderingCapability
    implements PosterRenderingCapability
{
    readonly #endpoint: URL;
    readonly #timeoutMs: number;
    readonly #fetch: typeof globalThis.fetch;

    constructor(options: {
        baseUrl: string;
        timeoutMs?: number;
        fetch?: typeof globalThis.fetch;
    }) {
        this.#endpoint = new URL("/posters", options.baseUrl);
        this.#timeoutMs = options.timeoutMs ?? 90_000;
        if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
            throw new Error("Poster API timeout must be a positive integer");
        }
        this.#fetch = options.fetch ?? globalThis.fetch;
    }

    async render(
        input: { prompt: string; aspectRatio: "3:5" },
        options: { signal: AbortSignal; idempotencyKey: string },
    ): Promise<PosterImage> {
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
            if (!response.ok) throw new Error("Poster API returned an error");
            return parsePosterImage(await response.json());
        } catch (error) {
            throw new PosterRenderingUnavailable({ cause: error });
        }
    }
}
