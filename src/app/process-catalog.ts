import { z } from "zod";
import type { ConsoleProcessDescription } from "../api/http.js";
import type { ProcessRegistry } from "../process-runtime/index.js";

/**
 * Describes the production catalog for the operator console.
 *
 * The field tables come from each Registration's own Schemas rather than a
 * second hand-written copy, so what operators read is what `accept` enforces.
 * This describes only; the request path never reads it, and it is not the
 * product-facing business interface documentation, which additionally carries
 * error semantics and billing boundaries that no Schema can express.
 */
export function describeProcessCatalog(
    registry: ProcessRegistry,
): readonly ConsoleProcessDescription[] {
    return Object.freeze(
        registry.list().map((registration) =>
            Object.freeze({
                process: registration.identity.id,
                version: registration.identity.version,
                activities: registration.activities,
                retry: Object.freeze({
                    maximumAttempts: registration.retryPolicy.maximumAttempts,
                    retryableErrorCodes:
                        registration.retryPolicy.retryableErrorCodes,
                }),
                // The input side documents what a caller sends and the output
                // side what it receives, which differ whenever a Schema
                // transforms on the way in.
                ...jsonSchemaField("input", registration.inputSchema, "input"),
                ...jsonSchemaField(
                    "output",
                    registration.outputSchema,
                    "output",
                ),
            }),
        ),
    );
}

/**
 * A Schema with no JSON Schema representation is omitted rather than thrown:
 * one undescribable Process must not take the whole catalog view down.
 */
function jsonSchemaField(
    field: "input" | "output",
    schema: z.ZodType,
    io: "input" | "output",
): Record<string, unknown> {
    try {
        return { [field]: z.toJSONSchema(schema, { io }) };
    } catch {
        return {};
    }
}
