/** agent.ts 里 ContentAgent Port 的生产 Pi 实现：只挂一个 Business Capability Tool 的受限 Session */
import { defineTool, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OpenAIApiMode } from "../../agent-runtime/pi.js";
import type { PiSessionFactory } from "../../agent-runtime/session.js";
import type { SkillRef } from "../../agent-runtime/skills.js";
import { PiTooledAgent } from "../../agent-runtime/tooled.js";
import type { ContentAgent, ContentAgentRequest } from "./agent.js";
import { contentToolName } from "./skills.js";

export type PiContentAgentOptions = {
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

/**
 * The production Agent adapter. The single Tool closes over the request's
 * permitted Capability, so the model can reach nothing the Registration did
 * not hand over; a second Tool call aborts the Session outright.
 */
export class PiContentAgent implements ContentAgent {
    readonly #agent: PiTooledAgent;

    constructor(options: PiContentAgentOptions) {
        this.#agent = new PiTooledAgent({
            ...options,
            instructions: [
                "You are a business content agent. Follow every bound Runtime Skill and return only the requested structured result.",
            ],
        });
    }

    async optimize(request: ContentAgentRequest): Promise<unknown> {
        const businessContentTool = defineTool({
            name: contentToolName,
            label: "Process business content",
            description:
                "Run content through the service's existing Business Capability.",
            parameters: Type.Object(
                {
                    content: Type.String({ minLength: 1 }),
                },
                { additionalProperties: false },
            ),
            execute: async (_toolCallId, input, toolSignal) => {
                const signal = toolSignal
                    ? AbortSignal.any([request.signal, toolSignal])
                    : request.signal;
                const result = await request.capability.process(input, {
                    signal,
                    idempotencyKey: request.idempotencyKey,
                });
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify(result) },
                    ],
                    details: {},
                };
            },
        });

        const result = await this.#agent.run({
            prompt:
                `Optimize this content: ${JSON.stringify(request.content)}\n` +
                `Call ${contentToolName} as directed by the Skills. ` +
                'Return only JSON matching {"content":"non-empty string"}.',
            tools: [businessContentTool],
            maxToolCalls: 1,
            signal: request.signal,
        });
        return result.output;
    }
}
