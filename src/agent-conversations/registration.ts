/** 定义准确 Agent Registration、文本 Content Block 契约与单次 Turn 执行边界 */
import { z } from "zod";

export const agentRegistrationBrand: unique symbol =
    Symbol("AgentRegistration");

const agentIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const agentVersionPattern = /^v[0-9]+(?:\.[0-9]+){0,2}$/;

const textContentSchema = z.strictObject({
    type: z.literal("text"),
    text: z.string().trim().min(1).max(12_000),
});

const turnInputSchema = z.strictObject({
    content: z.array(textContentSchema).min(1).max(16),
});

const turnOutputSchema = z.strictObject({
    content: z.array(textContentSchema).min(1).max(16),
});

export type AgentIdentity = Readonly<{ id: string; version: string }>;

export type AgentTextContent = Readonly<{
    type: "text";
    text: string;
}>;

export type AcceptedAgentTurnInput = Readonly<{
    content: readonly AgentTextContent[];
}>;

export type AgentTurnOutput = Readonly<{
    content: readonly AgentTextContent[];
}>;

export type AgentTurnErrorCode =
    | "AGENT_FAILURE"
    | "INTERNAL_ERROR"
    | "INVALID_OUTPUT";

export type AgentTurnCompletion =
    | Readonly<{ status: "succeeded"; output: AgentTurnOutput }>
    | Readonly<{
          status: "failed";
          error: Readonly<{ code: AgentTurnErrorCode; message: string }>;
      }>;

export type InteractiveAgentRequest = Readonly<{
    conversationId: string;
    turnId: string;
    input: AcceptedAgentTurnInput;
    signal: AbortSignal;
}>;

export type InteractiveAgent = Readonly<{
    respond: (request: InteractiveAgentRequest) => Promise<unknown>;
}>;

export type AgentRegistrationAcceptance =
    | Readonly<{ accepted: true; acceptedInput: AcceptedAgentTurnInput }>
    | Readonly<{ accepted: false }>;

export type AgentRegistration = Readonly<{
    identity: AgentIdentity;
    revision: string;
    accept: (input: unknown) => AgentRegistrationAcceptance;
    run: (request: InteractiveAgentRequest) => Promise<AgentTurnCompletion>;
    [agentRegistrationBrand]: true;
}>;

export function defineAgentRegistration(options: {
    id: string;
    version: string;
    revision: string;
    agent: InteractiveAgent;
}): AgentRegistration {
    assertAgentIdentity({ id: options.id, version: options.version });
    if (
        typeof options.revision !== "string" ||
        options.revision.trim().length === 0 ||
        Buffer.byteLength(options.revision, "utf8") > 256
    ) {
        throw new Error(
            "Agent Registration revision must be a non-empty string of at most 256 bytes",
        );
    }
    if (
        typeof options.agent !== "object" ||
        options.agent === null ||
        typeof options.agent.respond !== "function"
    ) {
        throw new Error("Interactive Agent is required");
    }

    return Object.freeze({
        identity: Object.freeze({ id: options.id, version: options.version }),
        revision: options.revision,
        accept: (input) => {
            const result = turnInputSchema.safeParse(input);
            return result.success
                ? Object.freeze({
                      accepted: true,
                      acceptedInput: freezeTurnInput(result.data),
                  })
                : Object.freeze({ accepted: false });
        },
        run: async (request) => {
            let response: unknown;
            try {
                response = await options.agent.respond(
                    Object.freeze({
                        ...request,
                        input: freezeTurnInput(request.input),
                    }),
                );
            } catch {
                return failed(
                    "AGENT_FAILURE",
                    "The Agent could not complete the Turn",
                );
            }
            const result = turnOutputSchema.safeParse(response);
            if (!result.success) {
                return failed(
                    "INVALID_OUTPUT",
                    "The Agent produced an invalid output",
                );
            }
            return Object.freeze({
                status: "succeeded",
                output: freezeTurnOutput(result.data),
            });
        },
        [agentRegistrationBrand]: true as const,
    });
}

export function assertAgentIdentity(identity: AgentIdentity): void {
    if (
        typeof identity !== "object" ||
        identity === null ||
        !agentIdPattern.test(identity.id) ||
        !agentVersionPattern.test(identity.version)
    ) {
        throw new Error("Agent identity is invalid");
    }
}

function freezeTurnInput(input: {
    content: readonly AgentTextContent[];
}): AcceptedAgentTurnInput {
    return Object.freeze({
        content: Object.freeze(
            input.content.map((block) => Object.freeze({ ...block })),
        ),
    });
}

function freezeTurnOutput(output: {
    content: readonly AgentTextContent[];
}): AgentTurnOutput {
    return freezeTurnInput(output);
}

function failed(
    code: AgentTurnErrorCode,
    message: string,
): AgentTurnCompletion {
    return Object.freeze({
        status: "failed",
        error: Object.freeze({ code, message }),
    });
}
