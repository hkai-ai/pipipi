import { describe, expect, it } from "vitest";
import { resolveModelGateway } from "../src/model-gateway.js";

describe("OpenAI image configuration", () => {
    it("uses an independent image API configuration when provided", () => {
        expect(
            resolveModelGateway(
                {
                    OPENAI_API_KEY: "agent-key",
                    OPENAI_BASE_URL: "https://chat.example/v1",
                    OPENAI_IMAGE_API_KEY: "image-key",
                    OPENAI_IMAGE_BASE_URL: "https://images.example/v1",
                },
                "image",
            ),
        ).toEqual({
            apiKey: "image-key",
            baseUrl: "https://images.example/v1",
        });
    });

    it("falls back to the shared OpenAI configuration", () => {
        expect(
            resolveModelGateway(
                {
                    OPENAI_API_KEY: "shared-key",
                    OPENAI_BASE_URL: "https://api.openai.com/v1",
                },
                "image",
            ),
        ).toEqual({
            apiKey: "shared-key",
            baseUrl: "https://api.openai.com/v1",
        });
    });

    it("requires at least one image-capable API key", () => {
        expect(() => resolveModelGateway({}, "image")).toThrow(/MODEL_GATEWAY/);
    });
});

const shared = {
    MODEL_GATEWAY_BASE_URL: "https://shared.example/v1",
    MODEL_GATEWAY_API_KEY: "shared-key",
};
it("uses the shared gateway for both selected model channels", () => {
    expect(resolveModelGateway(shared)).toEqual({
        baseUrl: shared.MODEL_GATEWAY_BASE_URL,
        apiKey: "shared-key",
    });
    expect(resolveModelGateway(shared, "image")).toEqual(
        resolveModelGateway(shared),
    );
    expect(
        resolveModelGateway(
            { ...shared, CHARACTER_EMOJI_IMAGE_ENABLED: "true" },
            "character-image",
        ),
    ).toEqual(resolveModelGateway(shared));
});
it("keeps an explicit generic image override coherent and ahead of the shared default", () => {
    expect(
        resolveModelGateway(
            { ...shared, OPENAI_IMAGE_API_KEY: "image-key" },
            "image",
        ),
    ).toEqual({ apiKey: "image-key", baseUrl: "https://api.openai.com/v1" });
    expect(() =>
        resolveModelGateway(
            { ...shared, OPENAI_IMAGE_BASE_URL: "https://image.example/v1" },
            "image",
        ),
    ).toThrow(/OPENAI_IMAGE/);
});
it.each(["image", "character-image"] as const)(
    "rejects incomplete shared credentials on enabled %s",
    (channel) => {
        expect(() =>
            resolveModelGateway(
                {
                    MODEL_GATEWAY_BASE_URL: shared.MODEL_GATEWAY_BASE_URL,
                    CHARACTER_EMOJI_IMAGE_ENABLED: "true",
                    CHARACTER_EMOJI_IMAGE_API_KEY: "old-image",
                    OPENAI_API_KEY: "old-openai",
                },
                channel,
            ),
        ).toThrow(/MODEL_GATEWAY/);
    },
);
it.each([
    {},
    shared,
    { ...shared, MAGIKARU_API_KEY: "backup-key" },
    {
        ...shared,
        CHARACTER_EMOJI_IMAGE_ENABLED: "false",
        CHARACTER_EMOJI_IMAGE_API_KEY: "old-key",
    },
])(
    "does not enable Flare from shared credentials or backup configuration: %j",
    (environment) => {
        expect(resolveModelGateway(environment, "character-image")).toEqual({});
    },
);
it("preserves legacy Flare activation but uses the explicit shared gateway when configured", () => {
    expect(
        resolveModelGateway(
            { CHARACTER_EMOJI_IMAGE_API_KEY: "old-key" },
            "character-image",
        ),
    ).toEqual({
        apiKey: "old-key",
        baseUrl: "https://llmapi.memene.cn/openai/v1",
    });
    expect(
        resolveModelGateway(
            {
                ...shared,
                CHARACTER_EMOJI_IMAGE_API_KEY: "old-key",
                CHARACTER_EMOJI_IMAGE_BASE_URL: "https://old-image.example/v1",
            },
            "character-image",
        ),
    ).toEqual(resolveModelGateway(shared));
});
it("preserves missing legacy key validation unless Flare is explicitly disabled", () => {
    expect(() =>
        resolveModelGateway(
            {
                ...shared,
                CHARACTER_EMOJI_IMAGE_BASE_URL: "https://old-image.example/v1",
            },
            "character-image",
        ),
    ).toThrow(/CHARACTER_EMOJI_IMAGE_API_KEY/);
    expect(
        resolveModelGateway(
            {
                CHARACTER_EMOJI_IMAGE_ENABLED: "false",
                CHARACTER_EMOJI_IMAGE_BASE_URL: "invalid",
            },
            "character-image",
        ),
    ).toEqual({});
    expect(() =>
        resolveModelGateway(
            { CHARACTER_EMOJI_IMAGE_ENABLED: "yes" },
            "character-image",
        ),
    ).toThrow(/true/);
});
