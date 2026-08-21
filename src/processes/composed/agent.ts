/** 带 Step Tool 的 Composed Planner Agent Port，生产实现见 agent.pi.ts */
import type { StepBudget, StepTool } from "./tools.js";

export type ComposedAgentRequest = Readonly<{
    goal: string;
    material: Readonly<Record<string, string>> | undefined;
    budget: StepBudget;
    tools: readonly StepTool[];
    /** Hard ceiling on Tool calls, above the budget the Tools enforce. */
    maxToolCalls: number;
    signal: AbortSignal;
}>;

export type ComposedAgent = Readonly<{
    /** Resolves to the model's final JSON; rejects when it could not finish. */
    plan: (request: ComposedAgentRequest) => Promise<unknown>;
}>;
