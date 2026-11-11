/** 通过内部 Business API 调用多参考图表情包渲染。 */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
    type CharacterEmojiRenderingCapability,
    CharacterEmojiRenderingUnavailable,
    characterEmojiImageSchema,
    characterEmojiRenderInputSchema,
} from "./capability.js";

export class HttpCharacterEmojiRenderingCapability
    implements CharacterEmojiRenderingCapability
{
    readonly #endpoint: URL;
    readonly #lookup?: URL;
    readonly #timeoutMs: number;

    constructor(options: {
        baseUrl: string;
        timeoutMs: number;
        recoverable?: boolean;
    }) {
        this.#endpoint = new URL(
            options.recoverable ? "/character-emojis/v4" : "/character-emojis",
            options.baseUrl,
        );
        if (options.recoverable)
            this.#lookup = new URL(
                "/character-emojis/v4/result",
                options.baseUrl,
            );
        this.#timeoutMs = options.timeoutMs;
    }

    async render(
        input: {
            prompt: string;
            imageUrls: readonly string[];
            size: string;
            background?: "transparent" | "opaque";
        },
        options: { signal: AbortSignal; idempotencyKey: string },
    ) {
        const signal = AbortSignal.any([
            options.signal,
            AbortSignal.timeout(this.#timeoutMs),
        ]);
        const headers = { "idempotency-key": options.idempotencyKey };
        const result = async (response: Response) => {
            if (!response.ok) {
                const body = await response.json().catch(() => null);
                throw new CharacterEmojiRenderingUnavailable(
                    ![
                        "CHARACTER_EMOJI_REJECTED",
                        "CHARACTER_EMOJI_CONFIGURATION_MISSING",
                    ].includes(body?.error?.code),
                );
            }
            return characterEmojiImageSchema.parse(await response.json());
        };
        let conflict = false;
        const started = Date.now();
        try {
            const response = await fetch(this.#endpoint, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify(input),
                signal,
            });
            conflict = response.status === 409;
            if (response.status !== 202) return await result(response);
            await response.body?.cancel();
        } catch (error) {
            if (
                !this.#lookup ||
                conflict ||
                options.signal.aborted ||
                (error instanceof CharacterEmojiRenderingUnavailable &&
                    !error.committed)
            ) {
                if (error instanceof CharacterEmojiRenderingUnavailable)
                    throw error;
                throw new CharacterEmojiRenderingUnavailable(true, {
                    cause: error,
                });
            }
        }
        if (!this.#lookup) throw new CharacterEmojiRenderingUnavailable(true);
        try {
            // 只查询同一运行；202 表示原处理仍在进行。
            const digest = createHash("sha256")
                .update(
                    JSON.stringify(
                        characterEmojiRenderInputSchema.parse(input),
                    ),
                )
                .digest("hex");
            // 提交等待超时后仍给同键核验最多五秒；用户取消和 Process 截止立即终止。
            const remaining = Math.max(
                1,
                this.#timeoutMs - (Date.now() - started) + 5000,
            );
            const lookupSignal = AbortSignal.any([
                options.signal,
                AbortSignal.timeout(remaining),
            ]);
            while (true) {
                const response = await fetch(this.#lookup, {
                    headers: { ...headers, "x-input-sha256": digest },
                    signal: lookupSignal,
                });
                if (response.status !== 202) return await result(response);
                await response.body?.cancel();
                await delay(1000, undefined, { signal: lookupSignal });
            }
        } catch (error) {
            throw new CharacterEmojiRenderingUnavailable(true, {
                cause: error,
            });
        }
    }
}
