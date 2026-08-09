import { z } from "zod";
import {
  ContentProcessingUnavailable,
  type ContentProcessingCapability,
} from "./business-capabilities.js";
import {
  defineProcessRegistration,
  failProcess,
  type ProcessRegistration,
} from "./process-runtime.js";

const titledContentInputSchema = z.strictObject({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

const titledContentOutputSchema = z.strictObject({
  title: z.string().trim().min(1),
  content: z.string().trim().min(1),
});

export type TitledContentProcessingConfig = {
  separator?: string;
};

export type TitledContentProcessingRegistrationOptions =
  TitledContentProcessingConfig & {
    contentProcessing: ContentProcessingCapability;
  };

export function createTitledContentProcessingRegistration(
  options: TitledContentProcessingRegistrationOptions,
): ProcessRegistration {
  if (
    typeof options.contentProcessing !== "object" ||
    options.contentProcessing === null ||
    typeof options.contentProcessing.process !== "function"
  ) {
    throw new Error("Content Processing Capability is required");
  }
  const separator = options.separator ?? "\n\n";
  const contentProcessing = options.contentProcessing;
  if (separator.length === 0) {
    throw new Error("The titled content separator cannot be empty");
  }

  return defineProcessRegistration({
    id: "titled-content-processing",
    version: "v1",
    inputSchema: titledContentInputSchema,
    outputSchema: titledContentOutputSchema,
    execute: async (input, context) => {
      const title = normalizeWhitespace(input.title);
      const body = normalizeWhitespace(input.body);
      try {
        const processed = await contentProcessing.process(
          { content: `${title}${separator}${body}` },
          { signal: context.signal, idempotencyKey: context.runId },
        );
        return { title, content: processed.content };
      } catch (error) {
        if (error instanceof ContentProcessingUnavailable) {
          return failProcess(
            "DEPENDENCY_FAILURE",
            "A required business service is unavailable",
          );
        }
        throw error;
      }
    },
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}
