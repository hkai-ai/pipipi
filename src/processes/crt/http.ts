import {
    type CrtImage,
    type CrtRenderingCapability,
    CrtRenderingUnavailable,
    crtRenderingIncompleteCode,
    parseCrtImage,
} from "./capability.js";
import type { CrtAspectRatio, CrtGrain, CrtPalette } from "./style.js";

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
            grain: CrtGrain;
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
            if (!response.ok) {
                throw new CrtRenderingUnavailable({
                    committed: await isCommittedFailure(response),
                });
            }
            return parseCrtImage(await response.json());
        } catch (error) {
            if (error instanceof CrtRenderingUnavailable) throw error;
            throw new CrtRenderingUnavailable({ cause: error });
        }
    }
}

/**
 * Reads only the stable error code from the failure body. Any other content is
 * discarded so vendor detail cannot escape through this Adapter, and an
 * unreadable body degrades to the cheaper "not committed" reading rather than
 * claiming a charge we cannot prove.
 */
async function isCommittedFailure(response: Response): Promise<boolean> {
    try {
        const body: unknown = await response.json();
        return (
            typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof body.error === "object" &&
            body.error !== null &&
            "code" in body.error &&
            body.error.code === crtRenderingIncompleteCode
        );
    } catch {
        return false;
    }
}
