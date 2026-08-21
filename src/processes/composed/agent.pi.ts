/** agent.ts 里 ComposedAgent Port 的生产 Pi 实现：把 Step Tool 挂成 Pi Tool，跑一段受限的规划 Session */
import {
    defineTool,
    type ModelRuntime,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { OpenAIApiMode } from "../../agent-runtime/pi.js";
import type { PiSessionFactory } from "../../agent-runtime/session.js";
import type { SkillRef } from "../../agent-runtime/skills.js";
import { PiTooledAgent } from "../../agent-runtime/tooled.js";
import type { ComposedAgent, ComposedAgentRequest } from "./agent.js";
import type { StepTool } from "./tools.js";

export type PiComposedAgentOptions = {
    skills: readonly SkillRef[];
    cwd?: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    modelRuntime?: ModelRuntime;
    sessionFactory?: PiSessionFactory;
};

/** Plans one goal with exactly the Step Tools the Registration hands over. */
export class PiComposedAgent implements ComposedAgent {
    readonly #agent: PiTooledAgent;

    constructor(options: PiComposedAgentOptions) {
        this.#agent = new PiTooledAgent({
            ...options,
            instructions: [
                "You are a planning agent for a business processing service.",
                "The only actions available to you are the Tools in this session; each runs one approved Business Process on the server.",
                "Follow the bound Runtime Skill. Finish with exactly one strict JSON object and no other text.",
            ],
        });
    }

    async plan(request: ComposedAgentRequest): Promise<unknown> {
        const result = await this.#agent.run({
            prompt: composePrompt(request),
            tools: request.tools.map(toPiTool),
            maxToolCalls: request.maxToolCalls,
            signal: request.signal,
        });
        return result.output;
    }
}

function composePrompt(request: ComposedAgentRequest): string {
    const pricedTools = request.tools
        .filter((tool) => tool.description.startsWith("Priced."))
        .map((tool) => tool.name);
    return [
        `Goal: ${JSON.stringify(request.goal)}`,
        request.material
            ? `Material: ${JSON.stringify(request.material)}`
            : "Material: none",
        `Budget: at most ${request.budget.maxSteps} steps in total, of which at most ${request.budget.maxPricedSteps} may succeed through priced Tools${
            pricedTools.length > 0 ? ` (${pricedTools.join(", ")})` : ""
        }.`,
        'Return only JSON matching {"summary":"one or two sentences","result":<values copied verbatim from successful step outputs, or null>}.',
    ].join("\n");
}

function toPiTool(tool: StepTool): ToolDefinition {
    return defineTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        // Zod's JSON Schema output is standard draft 2020-12, which TypeBox
        // validates as-is; only the static type needs the cast.
        parameters: tool.parameters as unknown as TSchema,
        executionMode: "sequential",
        execute: async (_toolCallId, input) => ({
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(await tool.execute(input)),
                },
            ],
            details: {},
        }),
    });
}
