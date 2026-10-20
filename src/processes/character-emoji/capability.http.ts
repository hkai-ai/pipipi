/** 通过内部 Business API 调用多参考图表情包渲染。 */
import {
    type CharacterEmojiRenderingCapability,
    CharacterEmojiRenderingUnavailable,
    characterEmojiImageSchema,
} from "./capability.js";

export class HttpCharacterEmojiRenderingCapability
    implements CharacterEmojiRenderingCapability
{
    readonly #endpoint: URL;
    readonly #timeoutMs: number;

    constructor(options: { baseUrl: string; timeoutMs: number }) {
        this.#endpoint = new URL("/character-emojis", options.baseUrl);
        this.#timeoutMs = options.timeoutMs;
    }

    async render(
        input: { prompt: string; imageUrls: readonly string[]; size: string },
        options: { signal: AbortSignal; idempotencyKey: string },
    ) {
        let dispatched = false;
        try {
            dispatched = true;
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
                const body = (await response.json().catch(() => null)) as {
                    error?: { code?: string };
                } | null;
                throw new CharacterEmojiRenderingUnavailable(
                    ![
                        "CHARACTER_EMOJI_REJECTED",
                        "CHARACTER_EMOJI_CONFIGURATION_MISSING",
                    ].includes(body?.error?.code ?? ""),
                );
            }
            return characterEmojiImageSchema.parse(await response.json());
        } catch (error) {
            if (error instanceof CharacterEmojiRenderingUnavailable)
                throw error;
            throw new CharacterEmojiRenderingUnavailable(dispatched, {
                cause: error,
            });
        }
    }
}
