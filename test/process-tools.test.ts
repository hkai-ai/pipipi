/** 验证受限 Agent 共用的 Process Tool Runtime 契约 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    createProcessToolRuntime,
    type ProcessToolSpec,
    processToolRunId,
} from "../src/agent-runtime/process-tools.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    defineProcessRegistration,
    failProcess,
} from "../src/process-runtime/index.js";

const textTool: ProcessToolSpec = {
    process: "text",
    version: "v1",
    toolName: "run_text",
    description: "Refine text.",
    sideEffect: "none",
};

function createRuntime(observed: Array<{ input: string; runId: string }> = []) {
    const registration = defineProcessRegistration({
        id: "text",
        version: "v1",
        inputSchema: z.strictObject({ content: z.string().trim().min(1) }),
        outputSchema: z.strictObject({ content: z.string() }),
        activities: [],
        execute: async (input, context) => {
            observed.push({ input: input.content, runId: context.runId });
            return { content: input.content.toUpperCase() };
        },
    });
    return createProcessToolRuntime({
        specs: [textTool],
        registry: createProcessRegistry([registration]),
        attemptRunner: createProcessAttemptRunner(),
        owner: { id: "interactive-agent", version: "v1" },
    });
}

describe("Process Tool Runtime", () => {
    it("derives the Tool Schema and runs the exact Registration with a stable child Run", async () => {
        const observed: Array<{ input: string; runId: string }> = [];
        const runtime = createRuntime(observed);

        expect(runtime.descriptors).toEqual([
            {
                name: "run_text",
                description: "Refine text.",
                parameters: {
                    type: "object",
                    properties: {
                        content: { type: "string", minLength: 1 },
                    },
                    required: ["content"],
                    additionalProperties: false,
                },
            },
        ]);

        await expect(
            runtime.invoke({
                toolName: "run_text",
                input: { content: "quiet" },
                parentRunId: "turn-1",
                invocation: 2,
                signal: new AbortController().signal,
            }),
        ).resolves.toEqual({
            invocation: 2,
            process: "text",
            version: "v1",
            sideEffect: "none",
            status: "succeeded",
            output: { content: "QUIET" },
        });
        expect(observed).toEqual([{ input: "quiet", runId: "turn-1.2" }]);
        expect(processToolRunId("turn-1", 2)).toBe("turn-1.2");
    });

    it("returns only a sanitized acceptance failure", async () => {
        const runtime = createRuntime();

        await expect(
            runtime.invoke({
                toolName: "run_text",
                input: { content: "  " },
                parentRunId: "turn-1",
                invocation: 1,
                signal: new AbortController().signal,
            }),
        ).resolves.toEqual({
            invocation: 1,
            process: "text",
            version: "v1",
            sideEffect: "none",
            status: "failed",
            error: {
                code: "INVALID_INPUT",
                message: "The Process Tool input is invalid",
            },
        });
    });

    it("retries only declared pre-commit failures with the stable child Run", async () => {
        const runIds: string[] = [];
        let attempts = 0;
        const registration = defineProcessRegistration({
            id: "text",
            version: "v1",
            inputSchema: z.strictObject({ content: z.string().min(1) }),
            outputSchema: z.strictObject({ content: z.string() }),
            activities: [],
            retryPolicy: {
                maximumAttempts: 2,
                retryableErrorCodes: ["DEPENDENCY_FAILURE"],
                backoff: { initialDelayMs: 1, maximumDelayMs: 1 },
            },
            execute: async (input, context) => {
                attempts += 1;
                runIds.push(context.runId);
                if (attempts === 1) {
                    return failProcess(
                        "DEPENDENCY_FAILURE",
                        "Dependency unavailable",
                    );
                }
                return { content: input.content };
            },
        });
        const runtime = createProcessToolRuntime({
            specs: [textTool],
            registry: createProcessRegistry([registration]),
            attemptRunner: createProcessAttemptRunner(),
        });

        await expect(
            runtime.invoke({
                toolName: "run_text",
                input: { content: "retry" },
                parentRunId: "turn-retry",
                invocation: 1,
                signal: new AbortController().signal,
            }),
        ).resolves.toMatchObject({ status: "succeeded" });
        expect(runIds).toEqual(["turn-retry.1", "turn-retry.1"]);
    });

    it("never retries an after-commit failure", async () => {
        let attempts = 0;
        const registration = defineProcessRegistration({
            id: "text",
            version: "v1",
            inputSchema: z.strictObject({ content: z.string().min(1) }),
            outputSchema: z.strictObject({ content: z.string() }),
            activities: [],
            retryPolicy: {
                maximumAttempts: 2,
                retryableErrorCodes: ["DEPENDENCY_FAILURE"],
                backoff: { initialDelayMs: 1, maximumDelayMs: 1 },
            },
            execute: async () => {
                attempts += 1;
                return failProcess(
                    "DEPENDENCY_FAILURE_AFTER_COMMIT",
                    "A priced effect already completed",
                );
            },
        });
        const runtime = createProcessToolRuntime({
            specs: [textTool],
            registry: createProcessRegistry([registration]),
            attemptRunner: createProcessAttemptRunner(),
        });

        await expect(
            runtime.invoke({
                toolName: "run_text",
                input: { content: "do not retry" },
                parentRunId: "turn-after-commit",
                invocation: 1,
                signal: new AbortController().signal,
            }),
        ).resolves.toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE_AFTER_COMMIT" },
        });
        expect(attempts).toBe(1);
    });

    it("rejects unavailable, duplicated, self-referential and unknown Tools", async () => {
        const registry = createProcessRegistry([]);
        const attemptRunner = createProcessAttemptRunner();

        expect(() =>
            createProcessToolRuntime({
                specs: [textTool],
                registry,
                attemptRunner,
            }),
        ).toThrow('Process Tool "text/v1" is not available');

        const runtime = createRuntime();
        expect(() =>
            createProcessToolRuntime({
                specs: [textTool, { ...textTool, toolName: "run_again" }],
                registry: createProcessRegistry([
                    defineProcessRegistration({
                        id: "text",
                        version: "v1",
                        inputSchema: z.object({}),
                        outputSchema: z.object({}),
                        activities: [],
                        execute: async () => ({}),
                    }),
                ]),
                attemptRunner,
            }),
        ).toThrow('Process Tool identity "text/v1" is duplicated');
        expect(() =>
            createProcessToolRuntime({
                specs: [textTool],
                registry: createProcessRegistry([
                    defineProcessRegistration({
                        id: "text",
                        version: "v1",
                        inputSchema: z.object({}),
                        outputSchema: z.object({}),
                        activities: [],
                        execute: async () => ({}),
                    }),
                ]),
                attemptRunner,
                owner: { id: "text", version: "v1" },
            }),
        ).toThrow('Process Tool "text/v1" cannot call itself');
        await expect(
            runtime.invoke({
                toolName: "unknown",
                input: {},
                parentRunId: "turn-1",
                invocation: 1,
                signal: new AbortController().signal,
            }),
        ).rejects.toThrow('Process Tool "unknown" is not available');
    });
});
