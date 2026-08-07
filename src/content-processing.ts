import { z } from "zod";
import type { AgentRuntime } from "./agent-runtime.js";
import {
  defineProcess,
  ProcessFailure,
  type ProcessDefinition,
} from "./process-runtime.js";

const contentProcessInputSchema = z.strictObject({
  content: z.string().trim().min(1),
});

const contentProcessOutputSchema = z.strictObject({
  content: z.string().trim().min(1),
});

const businessApiResponseSchema = z.strictObject({
  content: z.string().trim().min(1),
});

type ContentProcessInput = z.infer<typeof contentProcessInputSchema>;
type ContentProcessOutput = z.infer<typeof contentProcessOutputSchema>;

export type ContentProcessingCapability = {
  process: (
    input: { content: string },
    options: { signal: AbortSignal },
  ) => Promise<{ content: string }>;
};

export type ContentProcessCapabilities = {
  contentProcessing: ContentProcessingCapability;
  agentRuntime?: AgentRuntime;
};

export type ContentProcessingProcessConfig = {
  mode?: "direct" | "agent";
};

export function createContentProcessingProcess(
  config: ContentProcessingProcessConfig = {},
): ProcessDefinition<ContentProcessCapabilities> {
  const mode = config.mode ?? "direct";

  return defineProcess<
    ContentProcessInput,
    ContentProcessOutput,
    ContentProcessCapabilities
  >({
    id: "content-processing",
    version: "v1",
    inputSchema: contentProcessInputSchema,
    outputSchema: contentProcessOutputSchema,
    execute: async (input, context) => {
      const preparedContent = input.content.replace(/\s+/g, " ");
      if (mode === "direct") {
        return context.capabilities.contentProcessing.process(
          { content: preparedContent },
          { signal: context.signal },
        );
      }

      try {
        const rawOutput = await context.capabilities.agentRuntime?.optimize({
          content: preparedContent,
          signal: context.signal,
          processContent: (toolInput, toolOptions) =>
            context.capabilities.contentProcessing.process(
              toolInput,
              toolOptions,
            ),
        });
        const output = contentProcessOutputSchema.safeParse(rawOutput);
        if (!output.success) throw agentFailure();
        return output.data;
      } catch (error) {
        if (error instanceof ProcessFailure) throw error;
        throw agentFailure();
      }
    },
  });
}

function agentFailure(): ProcessFailure {
  return new ProcessFailure(
    "AGENT_FAILURE",
    "The content optimization agent could not complete the request",
  );
}

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
    options: { signal: AbortSignal },
  ): Promise<{ content: string }> {
    try {
      const response = await fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.any([
          options.signal,
          AbortSignal.timeout(this.#timeoutMs),
        ]),
      });
      if (!response.ok) throw new Error("Business API returned an error");

      const result = businessApiResponseSchema.safeParse(await response.json());
      if (!result.success) throw new Error("Business API returned invalid data");
      return result.data;
    } catch {
      throw new ProcessFailure(
        "DEPENDENCY_FAILURE",
        "A required business service is unavailable",
      );
    }
  }
}
