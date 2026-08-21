/** composed-task/v1 的 Process Tool Set：把 Member Registration 包装成 Planner 可调用的 Step Tool，记账每个 Step 并执行预算 */
import { z } from "zod";
import type {
    JsonValue,
    ProcessAttemptRunner,
    ProcessRegistration,
    ProcessRegistry,
    ProcessRunActivity,
} from "../../process-runtime/index.js";
import type { MemberSpec } from "./members.js";
import { runStep, type StepRecord } from "./steps.js";

export const stepActivity = "process_step";

export type StepBudget = Readonly<{
    maxSteps: number;
    maxPricedSteps: number;
}>;

/** A Tool as the Planner Agent Port sees it; free of any model-runtime type. */
export type StepTool = Readonly<{
    name: string;
    description: string;
    /** JSON Schema derived from the Member's own input Schema. */
    parameters: Readonly<Record<string, unknown>>;
    /** Never throws; every outcome is JSON the model can read. */
    execute: (input: unknown) => Promise<JsonValue>;
}>;

export type StepLedger = Readonly<{
    /** Steps actually run, in order; budget refusals are not Steps. */
    steps: () => readonly StepRecord[];
    /** Whether any priced Step has already succeeded. */
    pricedCommitted: () => boolean;
}>;

export type BoundToolSet = Readonly<{
    tools: readonly StepTool[];
    ledger: StepLedger;
}>;

export type ToolSetBinding = Readonly<{
    runId: string;
    signal: AbortSignal;
    runActivity: ProcessRunActivity;
    budget: StepBudget;
}>;

export type ProcessToolSet = Readonly<{
    /** The Members this set exposes, for prompts and descriptions. */
    members: readonly MemberSpec[];
    bind: (binding: ToolSetBinding) => BoundToolSet;
}>;

export type ProcessToolSetOptions = Readonly<{
    members: readonly MemberSpec[];
    registry: ProcessRegistry;
    attemptRunner: ProcessAttemptRunner;
}>;

const toolNamePattern = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Resolves every allow-listed Member against the Member Registry once, at
 * construction, and derives each Tool's parameter Schema from the Member's
 * own input Schema so what the model sees is what `accept` enforces.
 */
export function createProcessToolSet(
    options: ProcessToolSetOptions,
): ProcessToolSet {
    if (!Array.isArray(options.members) || options.members.length === 0) {
        throw new Error("composed-task requires at least one Member");
    }
    const names = new Set<string>();
    const resolved = options.members.map((member) => {
        if (!toolNamePattern.test(member.toolName)) {
            throw new Error(`Member Tool name "${member.toolName}" is invalid`);
        }
        if (names.has(member.toolName)) {
            throw new Error(
                `Member Tool name "${member.toolName}" is duplicated`,
            );
        }
        names.add(member.toolName);
        const registration = options.registry.find({
            id: member.process,
            version: member.version,
        });
        if (!registration) {
            throw new Error(
                `Member Process "${member.process}/${member.version}" is not available to composed-task`,
            );
        }
        return Object.freeze({
            member,
            registration,
            parameters: describeInput(registration),
        });
    });

    return Object.freeze({
        members: Object.freeze(options.members.map((member) => member)),
        bind: (binding) => {
            const steps: StepRecord[] = [];
            let pricedSucceeded = 0;
            // Steps are serialised even if the model issues parallel calls, so
            // step numbers, budgets and idempotency keys stay deterministic.
            let queue: Promise<unknown> = Promise.resolve();
            const enqueue = <Result>(task: () => Promise<Result>) => {
                const run = queue.then(task, task);
                queue = run.catch(() => undefined);
                return run;
            };

            const tools = resolved.map(
                ({ member, registration, parameters }): StepTool =>
                    Object.freeze({
                        name: member.toolName,
                        description: member.description,
                        parameters,
                        execute: (input) =>
                            enqueue(async () => {
                                if (steps.length >= binding.budget.maxSteps) {
                                    return refusal(
                                        "STEP_BUDGET_EXHAUSTED",
                                        "No further step is allowed in this run",
                                    );
                                }
                                if (
                                    member.sideEffect === "priced" &&
                                    pricedSucceeded >=
                                        binding.budget.maxPricedSteps
                                ) {
                                    return refusal(
                                        "PRICED_BUDGET_EXHAUSTED",
                                        "No further priced step is allowed in this run",
                                    );
                                }
                                const record = await binding.runActivity(
                                    stepActivity,
                                    () =>
                                        runStep({
                                            stepNumber: steps.length + 1,
                                            member,
                                            registration,
                                            input,
                                            attemptRunner:
                                                options.attemptRunner,
                                            parent: {
                                                runId: binding.runId,
                                                signal: binding.signal,
                                            },
                                        }),
                                );
                                steps.push(record);
                                if (
                                    record.priced &&
                                    record.status === "succeeded"
                                ) {
                                    pricedSucceeded += 1;
                                }
                                return publicStep(record);
                            }),
                    }),
            );

            return Object.freeze({
                tools: Object.freeze(tools),
                ledger: Object.freeze({
                    steps: () => Object.freeze([...steps]),
                    pricedCommitted: () => pricedSucceeded > 0,
                }),
            });
        },
    });
}

function describeInput(
    registration: ProcessRegistration,
): Readonly<Record<string, unknown>> {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(
        registration.inputSchema,
        { io: "input" },
    );
    return Object.freeze(schema);
}

function refusal(code: string, message: string): JsonValue {
    return Object.freeze({ error: Object.freeze({ code, message }) });
}

/** What the model reads back: the record without the internal priced flag. */
function publicStep(record: StepRecord): JsonValue {
    return Object.freeze({
        step: record.step,
        process: record.process,
        version: record.version,
        status: record.status,
        ...(record.output === undefined ? {} : { output: record.output }),
        ...(record.error ? { error: record.error } : {}),
    });
}
