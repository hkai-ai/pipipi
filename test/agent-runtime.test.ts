import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  configureOpenAIProvider,
  parseOpenAIApiMode,
} from "../src/processes/agent.js";

describe("OpenAI-compatible provider configuration", () => {
  it("routes the selected model through Chat Completions with reasoning off", async () => {
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    });

    configureOpenAIProvider(runtime, {
      baseUrl: "https://gateway.example/v1",
      apiMode: "chat-completions",
      modelId: "gpt-5.6-terra",
    });

    const model = runtime.getModel("openai", "gpt-5.6-terra");
    expect(model).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://gateway.example/v1",
      thinkingLevelMap: { off: "none" },
    });
  });

  it("rejects an unknown API mode", () => {
    expect(() => parseOpenAIApiMode("legacy-completions")).toThrow(
      "OPENAI_API_MODE must be responses or chat-completions",
    );
  });
});
