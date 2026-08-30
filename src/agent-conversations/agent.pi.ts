/** 把受控 Conversation Context 和已解析图片送入请求级无 Tool Pi Session */
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

export type PiInteractiveAgentOptions = PiSessionOptions;

export class PiInteractiveAgent implements InteractiveAgent {
    readonly #support: PiSessionSupport;

    constructor(options: PiInteractiveAgentOptions) {
        this.#support = new PiSessionSupport(options);
    }

    async respond(request: InteractiveAgentRequest): Promise<unknown> {
        const session = await this.#support.open({
            noTools: "all",
            customTools: [],
            tools: [],
        });
        return withAbortableSession(session, request.signal, async () => {
            await session.prompt(promptFor(request), {
                images: request.imageAccess.map((image) => ({
                    type: "image" as const,
                    mimeType: image.mediaType,
                    data: image.data,
                })),
            });
            return parseAgentJson(session.messages);
        });
    }
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
