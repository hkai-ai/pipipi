import { z } from "zod";
import {
    type ContentProcessingCapability,
    ContentProcessingUnavailable,
} from "../content/capability.js";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../runtime/index.js";

const titledContentInputSchema = z.strictObject({
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
});

const titledContentOutputSchema = z.strictObject({
    title: z.string().trim().min(1),
    content: z.string().trim().min(1),
});

export type TitledContentConfig = {
    separator?: string;
};

type RegistrationOptions = TitledContentConfig & {
    capability: ContentProcessingCapability;
};

export function createTitledContentRegistration(
    options: RegistrationOptions,
): ProcessRegistration {
    if (
        typeof options.capability !== "object" ||
        options.capability === null ||
        typeof options.capability.process !== "function"
    ) {
        throw new Error("Content Processing Capability is required");
    }
    const separator = options.separator ?? "\n\n";
    const capability = options.capability;
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
                const processed = await capability.process(
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
