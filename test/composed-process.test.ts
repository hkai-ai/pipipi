import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    createProcessRunner,
    defineProcessRegistration,
    type ExpectedProcessFailure,
    failProcess,
    type JsonValue,
    type ProcessRegistration,
    type ProcessRunLogRecord,
} from "../src/process-runtime/index.js";
import type { ComposedAgent } from "../src/processes/composed/agent.js";
import type { MemberSpec } from "../src/processes/composed/members.js";
import {
    type ComposedLimits,
    createComposedRegistration,
} from "../src/processes/composed/registration.js";
import {
    createProcessToolSet,
    type StepTool,
} from "../src/processes/composed/tools.js";

const runId = "00000000-0000-4000-8000-000000000077";

const members: readonly MemberSpec[] = [
    {
        process: "text",
        version: "v1",
        toolName: "run_text",
        description: "Refine text. Input {content}; output {content}.",
        sideEffect: "none",
    },
    {
        process: "image",
        version: "v1",
        toolName: "run_image",
        description: "Priced. Render an image. Input {brief}; output {url}.",
        sideEffect: "priced",
    },
];

type Observed = {
    textInputs: { content: string; runId: string }[];
    imageInputs: { brief: string; runId: string }[];
};

function defineMembers(
    observed: Observed,
    behaviour: {
        text?: (
            content: string,
        ) => Promise<{ content: string } | ExpectedProcessFailure>;
        image?: (
            brief: string,
            signal: AbortSignal,
        ) => Promise<{ url: string }>;
    } = {},
): readonly ProcessRegistration[] {
    return [
        defineProcessRegistration({
            id: "text",
            version: "v1",
            inputSchema: z.strictObject({ content: z.string().trim().min(1) }),
            outputSchema: z.strictObject({ content: z.string() }),
            activities: ["text_processing"],
            execute: async (input, context) => {
                observed.textInputs.push({
                    content: input.content,
                    runId: context.runId,
                });
                return context.runActivity("text_processing", () =>
                    behaviour.text
                        ? behaviour.text(input.content)
                        : { content: input.content.toUpperCase() },
                );
            },
        }),
        defineProcessRegistration({
            id: "image",
            version: "v1",
            inputSchema: z.strictObject({ brief: z.string().min(1) }),
            outputSchema: z.strictObject({ url: z.url() }),
            activities: ["image_rendering"],
            execute: async (input, context) => {
                observed.imageInputs.push({
                    brief: input.brief,
                    runId: context.runId,
                });
                return context.runActivity("image_rendering", () =>
                    behaviour.image
                        ? behaviour.image(input.brief, context.signal)
                        : {
                              url: `https://images.example/${encodeURIComponent(input.brief)}.png`,
                          },
                );
            },
        }),
    ];
}

type Script = (
    tools: Record<string, StepTool>,
    request: Parameters<ComposedAgent["plan"]>[0],
) => Promise<unknown>;

function scriptedAgent(script: Script): ComposedAgent {
    return {
        plan: (request) =>
            script(
                Object.fromEntries(
                    request.tools.map((tool) => [tool.name, tool]),
                ),
                request,
            ),
    };
}

function createComposed(options: {
    observed: Observed;
    agent: ComposedAgent;
    limits?: Partial<ComposedLimits>;
    behaviour?: Parameters<typeof defineMembers>[1];
    logSink?: (record: ProcessRunLogRecord) => void;
}) {
    const registry = createProcessRegistry(
        defineMembers(options.observed, options.behaviour),
    );
    const attemptRunner = createProcessAttemptRunner({
        processTimeoutMs: 1_000,
        logSink: options.logSink,
    });
    return createComposedRegistration({
        agent: options.agent,
        toolSet: createProcessToolSet({ members, registry, attemptRunner }),
        limits: {
            maxSteps: 4,
            maxPricedSteps: 1,
            timeoutMs: 5_000,
            ...options.limits,
        },
    });
}

async function runComposed(
    registration: ProcessRegistration,
    input: unknown,
    options: { logSink?: (record: ProcessRunLogRecord) => void } = {},
) {
    const acceptance = registration.accept(input);
    if (!acceptance.accepted) throw new Error("input was rejected");
    return createProcessAttemptRunner({
        processTimeoutMs: 5_000,
        logSink: options.logSink,
    }).run({
        runId,
        registration,
        acceptedInput: acceptance.acceptedInput,
    });
}

function newObserved(): Observed {
    return { textInputs: [], imageInputs: [] };
}

describe("composed-task/v1", () => {
    it("lets the Planner chain Members and reports every Step with a derived runId", async () => {
        const observed = newObserved();
        const records: ProcessRunLogRecord[] = [];
        const registration = createComposed({
            observed,
            logSink: (record) => {
                records.push(record);
            },
            agent: scriptedAgent(async (tools, request) => {
                expect(request.budget).toEqual({
                    maxSteps: 3,
                    maxPricedSteps: 1,
                });
                expect(request.maxToolCalls).toBe(5);
                const text = (await tools.run_text?.execute({
                    content: request.material?.copy,
                })) as { output: { content: string } };
                const image = (await tools.run_image?.execute({
                    brief: text.output.content,
                })) as { output: { url: string } };
                return {
                    summary: "Refined the copy, then rendered it.",
                    result: {
                        copy: text.output.content,
                        image: image.output,
                    },
                };
            }),
        });

        const result = await runComposed(
            registration,
            {
                goal: "Make a poster from the copy",
                material: { copy: "quiet rain" },
                constraints: { maxSteps: 3 },
            },
            {
                logSink: (record) => {
                    records.push(record);
                },
            },
        );

        expect(result).toEqual({
            runId,
            process: "composed-task",
            version: "v1",
            status: "succeeded",
            output: {
                summary: "Refined the copy, then rendered it.",
                steps: [
                    {
                        step: 1,
                        process: "text",
                        version: "v1",
                        status: "succeeded",
                        output: { content: "QUIET RAIN" },
                    },
                    {
                        step: 2,
                        process: "image",
                        version: "v1",
                        status: "succeeded",
                        output: {
                            url: "https://images.example/QUIET%20RAIN.png",
                        },
                    },
                ],
                result: {
                    copy: "QUIET RAIN",
                    image: { url: "https://images.example/QUIET%20RAIN.png" },
                },
            },
        });
        expect(observed.textInputs).toEqual([
            { content: "quiet rain", runId: `${runId}.1` },
        ]);
        expect(observed.imageInputs).toEqual([
            { brief: "QUIET RAIN", runId: `${runId}.2` },
        ]);

        const started = records.flatMap((record) =>
            record.event === "process_run_activity_started"
                ? [[record.runId, record.activity]]
                : [],
        );
        expect(started.filter(([id]) => id === runId)).toEqual([
            [runId, "planner_session"],
            [runId, "process_step"],
            [runId, "process_step"],
        ]);
        expect(started.filter(([id]) => id !== runId)).toEqual([
            [`${runId}.1`, "text_processing"],
            [`${runId}.2`, "image_rendering"],
        ]);
    });

    it("derives each Tool's parameters from the Member's own input Schema", () => {
        const registry = createProcessRegistry(defineMembers(newObserved()));
        const toolSet = createProcessToolSet({
            members,
            registry,
            attemptRunner: createProcessAttemptRunner(),
        });

        const bound = toolSet.bind({
            runId,
            signal: new AbortController().signal,
            runActivity: async (_activity, operation) => operation(),
            budget: { maxSteps: 1, maxPricedSteps: 0 },
        });

        expect(bound.tools.map((tool) => tool.name)).toEqual([
            "run_text",
            "run_image",
        ]);
        expect(bound.tools[0]?.parameters).toEqual({
            type: "object",
            properties: { content: { type: "string", minLength: 1 } },
            required: ["content"],
            additionalProperties: false,
        });
    });

    it("returns a rejected Step input to the Planner instead of failing the Run", async () => {
        const observed = newObserved();
        const registration = createComposed({
            observed,
            agent: scriptedAgent(async (tools) => {
                const rejected = await tools.run_text?.execute({
                    content: "   ",
                });
                const retried = (await tools.run_text?.execute({
                    content: "second try",
                })) as { output: JsonValue };
                expect(rejected).toEqual({
                    step: 1,
                    process: "text",
                    version: "v1",
                    status: "failed",
                    error: {
                        code: "INVALID_INPUT",
                        message: "The step input is invalid",
                    },
                });
                return { summary: "Retried once.", result: retried.output };
            }),
        });

        const result = await runComposed(registration, { goal: "Refine" });

        expect(result).toMatchObject({
            status: "succeeded",
            output: {
                steps: [
                    {
                        step: 1,
                        status: "failed",
                        error: { code: "INVALID_INPUT" },
                    },
                    {
                        step: 2,
                        status: "succeeded",
                        output: { content: "SECOND TRY" },
                    },
                ],
                result: { content: "SECOND TRY" },
            },
        });
        expect(observed.textInputs).toHaveLength(1);
    });

    it("refuses Steps beyond the budget without running a Member", async () => {
        const observed = newObserved();
        const refusals: unknown[] = [];
        const registration = createComposed({
            observed,
            limits: { maxSteps: 2, maxPricedSteps: 1 },
            agent: scriptedAgent(async (tools) => {
                const first = (await tools.run_image?.execute({
                    brief: "one",
                })) as { output: JsonValue };
                refusals.push(await tools.run_image?.execute({ brief: "two" }));
                await tools.run_text?.execute({ content: "fill" });
                refusals.push(await tools.run_text?.execute({ content: "x" }));
                return {
                    summary: "Stopped at the budget.",
                    result: first.output,
                };
            }),
        });

        const result = await runComposed(registration, {
            goal: "Render",
            constraints: { maxSteps: 8 },
        });

        expect(result).toMatchObject({ status: "succeeded" });
        expect(refusals).toEqual([
            {
                error: {
                    code: "PRICED_BUDGET_EXHAUSTED",
                    message: "No further priced step is allowed in this run",
                },
            },
            {
                error: {
                    code: "STEP_BUDGET_EXHAUSTED",
                    message: "No further step is allowed in this run",
                },
            },
        ]);
        expect(observed.imageInputs).toHaveLength(1);
        expect(observed.textInputs).toHaveLength(1);
    });

    it("rejects a result the Planner did not take verbatim from a successful Step", async () => {
        const observed = newObserved();
        const registration = createComposed({
            observed,
            agent: scriptedAgent(async (tools) => {
                await tools.run_text?.execute({ content: "copy" });
                return {
                    summary: "Paraphrased.",
                    result: { content: "Copy, lightly edited" },
                };
            }),
        });

        const result = await runComposed(registration, { goal: "Refine" });

        expect(result).toMatchObject({
            status: "failed",
            error: {
                code: "AGENT_FAILURE",
                message: "The planning agent could not complete the request",
            },
        });
    });

    it("treats a priced success followed by a Planner failure as a committed dependency failure", async () => {
        const observed = newObserved();
        const registration = createComposed({
            observed,
            agent: scriptedAgent(async (tools) => {
                await tools.run_image?.execute({ brief: "paid" });
                throw new Error("model error");
            }),
        });

        const result = await runComposed(registration, { goal: "Render" });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE_AFTER_COMMIT" },
        });
        expect(observed.imageInputs).toHaveLength(1);
    });

    it.each([
        {
            reason: "the Planner never ran a Step",
            script: (async () => ({
                summary: "Nothing.",
                result: null,
            })) as Script,
            textFails: false,
            code: "AGENT_FAILURE",
        },
        {
            reason: "the Planner threw before any Step",
            script: (async () => {
                throw new Error("model error");
            }) as Script,
            textFails: false,
            code: "AGENT_FAILURE",
        },
        {
            reason: "every Step failed on an unavailable dependency",
            script: (async (tools) => {
                await tools.run_text?.execute({ content: "a" });
                throw new Error("gave up");
            }) as Script,
            textFails: true,
            code: "DEPENDENCY_FAILURE",
        },
    ])("fails with $code when $reason", async ({ script, textFails, code }) => {
        const registration = createComposed({
            observed: newObserved(),
            agent: scriptedAgent(script),
            behaviour: textFails
                ? {
                      text: async () =>
                          failProcess("DEPENDENCY_FAILURE", "unavailable"),
                  }
                : {},
        });

        const result = await runComposed(registration, { goal: "Refine" });

        expect(result).toMatchObject({ status: "failed", error: { code } });
    });

    it("cancels a running Step when the parent Run times out", async () => {
        const observed = newObserved();
        let stepAborted = false;
        const registration = createComposed({
            observed,
            limits: { timeoutMs: 30 },
            behaviour: {
                image: (_brief, signal) =>
                    new Promise((resolve) => {
                        signal.addEventListener("abort", () => {
                            stepAborted = true;
                        });
                        setTimeout(
                            () => resolve({ url: "https://late.example/x" }),
                            500,
                        );
                    }),
            },
            agent: scriptedAgent(async (tools) => {
                const image = (await tools.run_image?.execute({
                    brief: "slow",
                })) as { output: JsonValue };
                return { summary: "Late.", result: image.output };
            }),
        });

        const result = await runComposed(registration, { goal: "Render" });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "PROCESS_TIMEOUT" },
        });
        expect(stepAborted).toBe(true);
    });

    it("rejects Members that the Member Registry cannot resolve", () => {
        const registry = createProcessRegistry(defineMembers(newObserved()));
        const attemptRunner = createProcessAttemptRunner();

        expect(() =>
            createProcessToolSet({
                members: [{ ...members[0], process: "absent" } as MemberSpec],
                registry,
                attemptRunner,
            }),
        ).toThrow(
            'Member Process "absent/v1" is not available to composed-task',
        );
        expect(() =>
            createProcessToolSet({
                members: [members[0], { ...members[1], toolName: "run_text" }],
                registry,
                attemptRunner,
            }),
        ).toThrow('Member Tool name "run_text" is duplicated');
    });

    it("rejects the input a product caller cannot send", () => {
        const registration = createComposed({
            observed: newObserved(),
            agent: scriptedAgent(async () => null),
        });

        for (const input of [
            { goal: "" },
            { goal: "x", material: { "Bad Key": "value" } },
            { goal: "x", material: { copy: "" } },
            { goal: "x", constraints: { maxSteps: 0 } },
            { goal: "x", constraints: { maxSteps: 9 } },
            { goal: "x", tools: ["run_text"] },
            { goal: "x", skills: ["anything"] },
        ]) {
            expect(registration.accept(input)).toEqual({ accepted: false });
        }
        expect(registration.timeoutMs).toBe(5_000);
        expect(registration.retryPolicy.maximumAttempts).toBe(1);
    });

    it("executes through the Process Runner like any other Process", async () => {
        const observed = newObserved();
        const registration = createComposed({
            observed,
            agent: scriptedAgent(async (tools) => {
                const text = (await tools.run_text?.execute({
                    content: "via runner",
                })) as { output: JsonValue };
                return { summary: "One step.", result: text.output };
            }),
        });
        const executor = createProcessRunner({
            registry: createProcessRegistry([registration]),
        });

        const result = await executor.execute({
            process: "composed-task",
            version: "v1",
            input: { goal: "Refine" },
        });

        expect(result).toMatchObject({
            status: "succeeded",
            output: { result: { content: "VIA RUNNER" } },
        });
        expect(observed.textInputs[0]?.runId).toBe(`${result.runId}.1`);
    });
});
