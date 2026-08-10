import {
    type CrtImage,
    type CrtRenderingCapability,
    CrtRenderingUnavailable,
    parseCrtImage,
} from "./capability.js";
import type { CrtAspectRatio, CrtPalette } from "./style.js";

export class HttpCrtRenderingCapability implements CrtRenderingCapability {
    readonly #endpoint: URL;
    readonly #timeoutMs: number;
    readonly #fetch: typeof globalThis.fetch;

    constructor(options: {
        baseUrl: string;
        timeoutMs?: number;
        fetch?: typeof globalThis.fetch;
    }) {
        this.#endpoint = new URL("/crt-images", options.baseUrl);
        this.#timeoutMs = options.timeoutMs ?? 180_000;
        if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
            throw new Error("CRT API timeout must be a positive integer");
        }
        this.#fetch = options.fetch ?? globalThis.fetch;
    }

    async transform(
        input: {
            sourceImageUrl: string;
            prompt: string;
            palette: CrtPalette;
            aspectRatio: CrtAspectRatio;
        },
        options: { signal: AbortSignal; idempotencyKey: string },
    ): Promise<CrtImage> {
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
            if (!response.ok) throw new Error("CRT API returned an error");
            return parseCrtImage(await response.json());
        } catch (error) {
            throw new CrtRenderingUnavailable({ cause: error });
        }
    }
}
