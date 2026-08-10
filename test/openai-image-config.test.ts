import { describe, expect, it } from "vitest";
import { resolveOpenAIImageConfiguration } from "../src/business-api/openai-image-config.js";

describe("OpenAI image configuration", () => {
    it("uses an independent image API configuration when provided", () => {
        expect(
            resolveOpenAIImageConfiguration({
                OPENAI_API_KEY: "agent-key",
                OPENAI_BASE_URL: "https://chat.example/v1",
                OPENAI_IMAGE_API_KEY: "image-key",
                OPENAI_IMAGE_BASE_URL: "https://images.example/v1",
            }),
        ).toEqual({
            apiKey: "image-key",
            baseUrl: "https://images.example/v1",
        });
    });

    it("falls back to the shared OpenAI configuration", () => {
        expect(
            resolveOpenAIImageConfiguration({
                OPENAI_API_KEY: "shared-key",
                OPENAI_BASE_URL: "https://api.openai.com/v1",
            }),
        ).toEqual({
            apiKey: "shared-key",
            baseUrl: "https://api.openai.com/v1",
        });
    });

    it("requires at least one image-capable API key", () => {
        expect(() => resolveOpenAIImageConfiguration({})).toThrow(
            "OPENAI_IMAGE_API_KEY or OPENAI_API_KEY is required",
        );
    });
});
