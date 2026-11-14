import { expect, it, vi } from "vitest";
import {
    characterEmojiModel,
    characterEmojiProvider,
    createCharacterEmojiModel,
} from "../src/processes/character-emoji/model.js";

it("通过真实 Pi Responses Adapter 在业务载荷过滤之前关闭 cache key", async () => {
    const runtime = await createCharacterEmojiModel({
        apiKey: "offline-key",
        baseUrl: "https://offline.example/v1",
    });
    const model = runtime.getModel(characterEmojiProvider, characterEmojiModel);
    expect(model).toBeDefined();
    expect(model.compat.promptCacheKeyMode).toBe("disabled");
    const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network"));
    try {
        for (const disabled of [false, true]) {
            const onPayload = vi.fn((payload) => {
                expect(payload.prompt_cache_key).toBe(
                    disabled ? undefined : "test-session",
                );
                throw new Error("Stop before transport");
            });
            const result = await runtime.completeSimple(
                {
                    ...model,
                    compat: {
                        ...model.compat,
                        promptCacheKeyMode: disabled ? "disabled" : "enabled",
                    },
                },
                {
                    messages: [
                        { role: "user", content: "Synthetic", timestamp: 0 },
                    ],
                },
                {
                    sessionId: "test-session",
                    cacheRetention: "short",
                    onPayload,
                },
            );
            expect(onPayload).toHaveBeenCalledOnce();
            expect(result.stopReason).toBe("error");
            expect(result.errorMessage).toContain("Stop before transport");
        }
        expect(fetcher).not.toHaveBeenCalled();
    } finally {
        fetcher.mockRestore();
    }
});
