/** 定义准确 Agent Registration、文本 Content Block、上下文与资源上限契约 */
import { z } from "zod";

export const agentRegistrationBrand: unique symbol =
    Symbol("AgentRegistration");

const agentIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const agentVersionPattern = /^v[0-9]+(?:\.[0-9]+){0,2}$/;

export const globalAgentLimits = Object.freeze({
    maxTurns: 256,
    maxInputBytes: 48_000,
    maxOutputBytes: 48_000,
    maxContextTokens: 64_000,
    maxHistoryTurns: 32,
    maxSummaryTokens: 8_000,
    maxHistoryPageSize: 100,
});

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

export type AgentRegistrationLimits = Readonly<{
    maxTurns: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    maxContextTokens: number;
    maxHistoryTurns: number;
    maxSummaryTokens: number;
    historyPageSize: number;
}>;

export type AgentPublicHistoryTurn = Readonly<{
    turnId: string;
    sequence: number;
    input: AcceptedAgentTurnInput;
    output: AgentTurnOutput;
}>;

export type AgentConversationContext = Readonly<{
    workingSummary?: string;
    history: readonly AgentPublicHistoryTurn[];
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
    context: AgentConversationContext;
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
    limits: AgentRegistrationLimits;
    accept: (input: unknown) => AgentRegistrationAcceptance;
    run: (request: InteractiveAgentRequest) => Promise<AgentTurnCompletion>;
    [agentRegistrationBrand]: true;
}>;

export function defineAgentRegistration(options: {
    id: string;
    version: string;
    revision: string;
    agent: InteractiveAgent;
    limits?: Partial<AgentRegistrationLimits>;
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
    const limits = defineLimits(options.limits);

    return Object.freeze({
        identity: Object.freeze({ id: options.id, version: options.version }),
        revision: options.revision,
        limits,
        accept: (input) => {
            const result = turnInputSchema.safeParse(input);
            return result.success &&
                contentBytes(result.data.content) <= limits.maxInputBytes
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
            if (
                !result.success ||
                contentBytes(result.data.content) > limits.maxOutputBytes
            ) {
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

function defineLimits(
    requested: Partial<AgentRegistrationLimits> | undefined,
): AgentRegistrationLimits {
    const limits = {
        maxTurns: requested?.maxTurns ?? globalAgentLimits.maxTurns,
        maxInputBytes:
            requested?.maxInputBytes ?? globalAgentLimits.maxInputBytes,
        maxOutputBytes:
            requested?.maxOutputBytes ?? globalAgentLimits.maxOutputBytes,
        maxContextTokens:
            requested?.maxContextTokens ?? globalAgentLimits.maxContextTokens,
        maxHistoryTurns:
            requested?.maxHistoryTurns ?? globalAgentLimits.maxHistoryTurns,
        maxSummaryTokens:
            requested?.maxSummaryTokens ?? globalAgentLimits.maxSummaryTokens,
        historyPageSize:
            requested?.historyPageSize ?? globalAgentLimits.maxHistoryPageSize,
    };
    for (const [name, value] of Object.entries(limits)) {
        const globalName =
            name === "historyPageSize" ? "maxHistoryPageSize" : name;
        const globalLimit =
            globalAgentLimits[globalName as keyof typeof globalAgentLimits];
        if (!Number.isInteger(value) || value < 1 || value > globalLimit) {
            throw new Error(
                `Agent Registration ${name} must be an integer between 1 and ${globalLimit}`,
            );
        }
    }
    if (limits.maxSummaryTokens >= limits.maxContextTokens) {
        throw new Error(
            "Agent Registration maxSummaryTokens must be less than maxContextTokens",
        );
    }
    if (limits.maxInputBytes + 128 > limits.maxContextTokens) {
        throw new Error(
            "Agent Registration maxInputBytes must leave Context envelope capacity",
        );
    }
    return Object.freeze(limits);
}

function contentBytes(content: readonly AgentTextContent[]): number {
    return content.reduce(
        (total, block) => total + Buffer.byteLength(block.text, "utf8"),
        0,
    );
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
