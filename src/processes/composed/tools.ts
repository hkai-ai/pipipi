/** composed-task/v1 的 Process Tool Set：把共享 Process Tool Runtime 投影成 Planner Step，并执行预算和记账 */
import type {
    ProcessToolInvocation,
    ProcessToolRuntime,
} from "../../agent-runtime/process-tools.js";
import { createProcessToolRuntime } from "../../agent-runtime/process-tools.js";
import type {
    JsonValue,
    ProcessAttemptRunner,
    ProcessErrorCode,
    ProcessRegistry,
    ProcessRunActivity,
} from "../../process-runtime/index.js";
import type { MemberSpec } from "./members.js";

export const stepActivity = "process_step";

export type StepBudget = Readonly<{
    maxSteps: number;
    maxPricedSteps: number;
}>;

export type StepRecord = Readonly<{
    step: number;
    process: string;
    version: string;
    status: "succeeded" | "failed";
    output?: JsonValue;
    error?: Readonly<{
        code: ProcessErrorCode;
        message: string;
    }>;
    priced: boolean;
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

/**
 * Resolves every allow-listed Member against the Member Registry once, at
 * construction, and derives each Tool's parameter Schema from the Member's
 * own input Schema so what the model sees is what `accept` enforces.
 */
export function createProcessToolSet(
    options: ProcessToolSetOptions,
): ProcessToolSet {
    const runtime = createProcessToolRuntime({
        specs: options.members,
        registry: options.registry,
        attemptRunner: options.attemptRunner,
        owner: { id: "composed-task", version: "v1" },
    });

    return Object.freeze({
        members: runtime.specs,
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

            const tools = runtime.descriptors.map(
                (descriptor): StepTool =>
                    Object.freeze({
                        name: descriptor.name,
                        description: descriptor.description,
                        parameters: descriptor.parameters,
                        execute: (input) =>
                            enqueue(async () => {
                                if (steps.length >= binding.budget.maxSteps) {
                                    return refusal(
                                        "STEP_BUDGET_EXHAUSTED",
                                        "No further step is allowed in this run",
                                    );
                                }
                                if (
                                    sideEffectFor(runtime, descriptor.name) ===
                                        "priced" &&
                                    pricedSucceeded >=
                                        binding.budget.maxPricedSteps
                                ) {
                                    return refusal(
                                        "PRICED_BUDGET_EXHAUSTED",
                                        "No further priced step is allowed in this run",
                                    );
                                }
                                const invocation = await binding.runActivity(
                                    stepActivity,
                                    () =>
                                        runtime.invoke({
                                            toolName: descriptor.name,
                                            input,
                                            parentRunId: binding.runId,
                                            invocation: steps.length + 1,
                                            signal: binding.signal,
                                        }),
                                );
                                const record = toStepRecord(invocation);
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

function refusal(code: string, message: string): JsonValue {
    return Object.freeze({ error: Object.freeze({ code, message }) });
}

function sideEffectFor(
    runtime: ProcessToolRuntime,
    toolName: string,
): MemberSpec["sideEffect"] {
    const spec = runtime.specs.find(
        (candidate) => candidate.toolName === toolName,
    );
    if (!spec) throw new Error(`Process Tool "${toolName}" is not available`);
    return spec.sideEffect;
}

function toStepRecord(invocation: ProcessToolInvocation): StepRecord {
    const error =
        invocation.error?.code === "INVALID_INPUT"
            ? Object.freeze({
                  code: invocation.error.code,
                  message: "The step input is invalid",
              })
            : invocation.error;
    return Object.freeze({
        step: invocation.invocation,
        process: invocation.process,
        version: invocation.version,
        status: invocation.status,
        ...(invocation.output === undefined
            ? {}
            : { output: invocation.output }),
        ...(error ? { error } : {}),
        priced: invocation.sideEffect === "priced",
    });
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
