/** 把受控 Context、图片和 Registration Process Tool 送入请求级 Pi Session */
import {
    defineTool,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { parseAgentJson } from "../agent-runtime/pi.js";
import {
    type PiSessionOptions,
    PiSessionSupport,
    withAbortableSession,
} from "../agent-runtime/session.js";
import type {
    InteractiveAgent,
    InteractiveAgentRequest,
} from "./registration.js";
import type { AgentProcessTool } from "./tools.js";

export type PiInteractiveAgentOptions = PiSessionOptions;

export class PiInteractiveAgent implements InteractiveAgent {
    readonly #support: PiSessionSupport;

    constructor(options: PiInteractiveAgentOptions) {
        this.#support = new PiSessionSupport(options);
    }

    async respond(request: InteractiveAgentRequest): Promise<unknown> {
        let toolCalls = 0;
        let budgetExceeded = false;
        let abortSession = () => {};
        const tools = request.processTools.map((tool) =>
            toPiTool(tool, async (operation) => {
                toolCalls += 1;
                if (toolCalls > request.maxToolCalls) {
                    budgetExceeded = true;
                    abortSession();
                    throw new Error("The Agent exceeded its Tool call budget");
                }
                return operation();
            }),
        );
        const session = await this.#support.open(
            tools.length === 0
                ? { noTools: "all", customTools: [], tools: [] }
                : {
                      customTools: tools,
                      tools: tools.map((tool) => tool.name),
                  },
        );
        abortSession = () => {
            void session.abort();
        };
        return withAbortableSession(session, request.signal, async () => {
            await session.prompt(promptFor(request), {
                images: request.imageAccess.map((image) => ({
                    type: "image" as const,
                    mimeType: image.mediaType,
                    data: image.data,
                })),
            });
            if (budgetExceeded) {
                throw new Error("The Agent exceeded its Tool call budget");
            }
            return parseAgentJson(session.messages);
        });
    }
}

function toPiTool(
    tool: AgentProcessTool,
    guard: <Result>(operation: () => Promise<Result>) => Promise<Result>,
): ToolDefinition {
    return defineTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as TSchema,
        executionMode: "sequential",
        execute: async (_toolCallId, input) => ({
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(
                        await guard(() => tool.execute(input)),
                    ),
                },
            ],
            details: {},
        }),
    });
}

function promptFor(request: InteractiveAgentRequest): string {
    return [
        "Continue this Agent Conversation from the server-owned public context.",
        "Image resource metadata in the JSON corresponds by resourceId to the attached images.",
        'Return only strict JSON with content blocks. Text blocks are {"type":"text","text":"..."}.',
        'An image block is allowed only for a resource created by an approved Tool or Adapter in this Turn and is {"type":"image","resourceId":"..."}.',
        JSON.stringify({
            context: request.context,
            input: request.input,
        }),
    ].join("\n");
}
