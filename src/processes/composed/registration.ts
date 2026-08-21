/** composed-task/v1 的 Schema、预算、Planner 调用、Step 记账收敛、result 来源校验和稳定失败 */
import { z } from "zod";
import {
    defineProcessRegistration,
    type ExpectedProcessFailure,
    failProcess,
    type JsonValue,
    type ProcessRegistration,
} from "../../process-runtime/index.js";
import type { ComposedAgent } from "./agent.js";
import type { StepRecord } from "./steps.js";
import type { ProcessToolSet, StepBudget } from "./tools.js";

export const plannerActivity = "planner_session";

const materialKeyPattern = /^[a-z][a-zA-Z0-9]{0,31}$/;

const inputSchema = z.strictObject({
    goal: z.string().trim().min(1).max(4_000),
    material: z
        .record(
            z.string().regex(materialKeyPattern),
            z.string().min(1).max(12_000),
        )
        .refine((value) => Object.keys(value).length <= 16, {
            message: "At most 16 material entries are allowed",
        })
        .optional(),
    constraints: z
        .strictObject({
            maxSteps: z.int().min(1).max(8).optional(),
        })
        .optional(),
});

const stepSchema = z.strictObject({
    step: z.int().min(1),
    process: z.string().min(1),
    version: z.string().min(1),
    status: z.enum(["succeeded", "failed"]),
    output: z.json().optional(),
    error: z
        .strictObject({ code: z.string().min(1), message: z.string().min(1) })
        .optional(),
});

const outputSchema = z.strictObject({
    summary: z.string().trim().min(1).max(2_000),
    steps: z.array(stepSchema).min(1),
    result: z.json(),
});

/** What the Planner must return; the Registration supplies `steps` itself. */
const plannerOutputSchema = z.strictObject({
    summary: z.string().trim().min(1).max(2_000),
    result: z.json(),
});

export type ComposedLimits = Readonly<{
    maxSteps: number;
    maxPricedSteps: number;
    /** The whole Run's time limit, covering every Step it starts. */
    timeoutMs: number;
}>;

type RegistrationOptions = Readonly<{
    agent: ComposedAgent;
    toolSet: ProcessToolSet;
    limits: ComposedLimits;
}>;

/** Refusals beyond this many calls abort the Session outright. */
const toolCallSlack = 2;

export function createComposedRegistration(
    options: RegistrationOptions,
): ProcessRegistration {
    if (
        typeof options.agent !== "object" ||
        options.agent === null ||
        typeof options.agent.plan !== "function"
    ) {
        throw new Error("Composed Agent is required");
    }
    if (
        typeof options.toolSet !== "object" ||
        options.toolSet === null ||
        typeof options.toolSet.bind !== "function"
    ) {
        throw new Error("Process Tool Set is required");
    }
    const limits = normalizeLimits(options.limits);
    const agent = options.agent;
    const toolSet = options.toolSet;

    return defineProcessRegistration({
        id: "composed-task",
        version: "v1",
        inputSchema,
        outputSchema,
        activities: [plannerActivity, "process_step"],
        timeoutMs: limits.timeoutMs,
        execute: async (input, context) => {
            const budget: StepBudget = {
                maxSteps: Math.min(
                    input.constraints?.maxSteps ?? limits.maxSteps,
                    limits.maxSteps,
                ),
                maxPricedSteps: limits.maxPricedSteps,
            };
            const bound = toolSet.bind({
                runId: context.runId,
                signal: context.signal,
                runActivity: context.runActivity,
                budget,
            });

            let rawOutput: unknown;
            try {
                rawOutput = await context.runActivity(plannerActivity, () =>
                    agent.plan({
                        goal: input.goal.replace(/\s+/g, " "),
                        material: input.material,
                        budget,
                        tools: bound.tools,
                        maxToolCalls: budget.maxSteps + toolCallSlack,
                        signal: context.signal,
                    }),
                );
            } catch {
                return plannerFailure(bound.ledger.steps(), {
                    pricedCommitted: bound.ledger.pricedCommitted(),
                });
            }

            const steps = bound.ledger.steps();
            const succeeded = steps.filter(
                (step) => step.status === "succeeded",
            );
            const planned = plannerOutputSchema.safeParse(rawOutput);
            if (
                succeeded.length === 0 ||
                !planned.success ||
                !isDerivedFromSteps(planned.data.result, succeeded)
            ) {
                return bound.ledger.pricedCommitted()
                    ? afterCommitFailure()
                    : agentFailure();
            }

            return {
                summary: planned.data.summary,
                steps: steps.map(publicStep),
                result: planned.data.result,
            };
        },
    });
}

function normalizeLimits(limits: ComposedLimits): ComposedLimits {
    if (
        !Number.isSafeInteger(limits?.maxSteps) ||
        limits.maxSteps < 1 ||
        limits.maxSteps > 8
    ) {
        throw new Error("composed-task maxSteps must be between 1 and 8");
    }
    if (
        !Number.isSafeInteger(limits.maxPricedSteps) ||
        limits.maxPricedSteps < 0 ||
        limits.maxPricedSteps > 4
    ) {
        throw new Error("composed-task maxPricedSteps must be between 0 and 4");
    }
    if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1) {
        throw new Error("composed-task timeoutMs must be a positive integer");
    }
    return Object.freeze({
        maxSteps: limits.maxSteps,
        maxPricedSteps: limits.maxPricedSteps,
        timeoutMs: limits.timeoutMs,
    });
}

/**
 * The Planner did not finish. Money already spent turns this into a failure a
 * human must look at; otherwise it is a dependency problem only when every
 * Step that ran failed on a dependency, and an Agent problem in all other cases.
 */
function plannerFailure(
    steps: readonly StepRecord[],
    state: { pricedCommitted: boolean },
): ExpectedProcessFailure {
    if (state.pricedCommitted) return afterCommitFailure();
    const onlyDependencyFailures =
        steps.length > 0 &&
        steps.every(
            (step) =>
                step.status === "failed" &&
                step.error?.code === "DEPENDENCY_FAILURE",
        );
    return onlyDependencyFailures
        ? failProcess(
              "DEPENDENCY_FAILURE",
              "A required business service is unavailable",
          )
        : agentFailure();
}

function agentFailure(): ExpectedProcessFailure {
    return failProcess(
        "AGENT_FAILURE",
        "The planning agent could not complete the request",
    );
}

function afterCommitFailure(): ExpectedProcessFailure {
    return failProcess(
        "DEPENDENCY_FAILURE_AFTER_COMMIT",
        "A priced step succeeded but the request could not be completed",
    );
}

function publicStep(record: StepRecord): z.input<typeof stepSchema> {
    return {
        step: record.step,
        process: record.process,
        version: record.version,
        status: record.status,
        // JsonValue is the read-only twin of zod's JSONType; the data is the same.
        ...(record.output === undefined
            ? {}
            : { output: record.output as unknown as z.JSONType }),
        ...(record.error ? { error: { ...record.error } } : {}),
    };
}

/** Stops collecting once a result could not plausibly be this large anyway. */
const maxSubtrees = 50_000;

/**
 * `result` may be one successful Step's output, any value inside one, or a
 * flat object whose values are such copies. Anything else is the model
 * paraphrasing or inventing, which the caller must never receive as a result.
 */
function isDerivedFromSteps(
    result: JsonValue,
    succeeded: readonly StepRecord[],
): boolean {
    const subtrees = new Set<string>();
    for (const step of succeeded) {
        if (step.output !== undefined) collectSubtrees(step.output, subtrees);
    }
    const matches = (value: JsonValue) => subtrees.has(JSON.stringify(value));
    if (matches(result)) return true;
    if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result)
    ) {
        return false;
    }
    const values = Object.values(result);
    return values.length > 0 && values.every(matches);
}

function collectSubtrees(value: JsonValue, into: Set<string>): void {
    if (into.size >= maxSubtrees) return;
    into.add(JSON.stringify(value));
    if (typeof value !== "object" || value === null) return;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
        collectSubtrees(child, into);
    }
}
