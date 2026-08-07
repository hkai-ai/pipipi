import { z } from "zod";
import type { ContentProcessCapabilities } from "./content-processing.js";
import { defineProcess, type ProcessDefinition } from "./process-runtime.js";

const titledContentInputSchema = z.strictObject({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

const titledContentOutputSchema = z.strictObject({
  title: z.string().trim().min(1),
  content: z.string().trim().min(1),
});

type TitledContentInput = z.infer<typeof titledContentInputSchema>;
type TitledContentOutput = z.infer<typeof titledContentOutputSchema>;

export type TitledContentProcessingConfig = {
  separator?: string;
};

export function createTitledContentProcessingProcess(
  config: TitledContentProcessingConfig = {},
): ProcessDefinition<ContentProcessCapabilities> {
  const separator = config.separator ?? "\n\n";
  if (separator.length === 0) {
    throw new Error("The titled content separator cannot be empty");
  }

  return defineProcess<
    TitledContentInput,
    TitledContentOutput,
    ContentProcessCapabilities
  >({
    id: "titled-content-processing",
    version: "v1",
    inputSchema: titledContentInputSchema,
    outputSchema: titledContentOutputSchema,
    execute: async (input, context) => {
      const title = normalizeWhitespace(input.title);
      const body = normalizeWhitespace(input.body);
      const processed = await context.capabilities.contentProcessing.process(
        { content: `${title}${separator}${body}` },
        { signal: context.signal },
      );
      return { title, content: processed.content };
    },
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}
