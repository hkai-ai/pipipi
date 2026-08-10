import { describe, expect, it } from "vitest";
import { FalImageGenerationClient } from "../src/business-api/fal-image-generation.js";
import { createImageGenerationClient } from "../src/business-api/image-generation-config.js";
import { OpenAIImageGenerationClient } from "../src/business-api/openai-image-generation.js";

describe("image generation configuration", () => {
    it("keeps OpenAI as the default provider", () => {
        const resolved = createImageGenerationClient({
            OPENAI_API_KEY: "openai-key",
        });

        expect(resolved.provider).toBe("openai");
        expect(resolved.client).toBeInstanceOf(OpenAIImageGenerationClient);
    });

    it("selects FAL with an independent server-side key", () => {
        const resolved = createImageGenerationClient({
            IMAGE_PROVIDER: "fal",
            FAL_KEY: "fal-key",
        });

        expect(resolved.provider).toBe("fal");
        expect(resolved.client).toBeInstanceOf(FalImageGenerationClient);
    });

    it("requires the selected provider key", () => {
        expect(() =>
            createImageGenerationClient({ IMAGE_PROVIDER: "fal" }),
        ).toThrow("FAL_KEY is required when IMAGE_PROVIDER=fal");
    });

    it("rejects unknown providers", () => {
        expect(() =>
            createImageGenerationClient({
                IMAGE_PROVIDER: "unknown",
                OPENAI_API_KEY: "openai-key",
            }),
        ).toThrow("IMAGE_PROVIDER must be openai or fal");
    });
});
