import { z } from "zod";
import {
    type ContentProcessingCapability,
    ContentProcessingUnavailable,
} from "./capability.js";

const businessApiResponseSchema = z.strictObject({
    content: z.string().trim().min(1),
});

export class HttpContentProcessingCapability
    implements ContentProcessingCapability
{
    readonly #endpoint: URL;
    readonly #timeoutMs: number;

    constructor(options: { baseUrl: string; timeoutMs?: number }) {
        this.#endpoint = new URL("/process", options.baseUrl);
        this.#timeoutMs = options.timeoutMs ?? 10_000;
    }

    async process(
        input: { content: string },
        options: { signal: AbortSignal; idempotencyKey: string },
    ): Promise<{ content: string }> {
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
            if (!response.ok) throw new Error("Business API returned an error");

            const result = businessApiResponseSchema.safeParse(
                await response.json(),
            );
            if (!result.success) {
                throw new Error("Business API returned invalid data");
            }
            return result.data;
        } catch (error) {
            throw new ContentProcessingUnavailable({ cause: error });
        }
    }
}
