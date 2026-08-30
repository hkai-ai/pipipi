/** 定义准确 Agent Registration、多模态 Content Block、Context 与资源上限契约 */
import { z } from "zod";
import {
    type AgentImageAccess,
    type AgentImageMediaType,
    type AgentImageResource,
    type AgentResourceResolver,
    agentImageMediaTypes,
} from "./resource.js";

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
    maxImagesPerTurn: 4,
    maxImageBytes: 10_485_760,
    maxImageTotalBytes: 20_971_520,
    maxImageWidth: 8_192,
    maxImageHeight: 8_192,
});

const textContentSchema = z.strictObject({
    type: z.literal("text"),
    text: z.string().trim().min(1).max(12_000),
});
const imageReferenceSchema = z.strictObject({
    type: z.literal("image"),
    resourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
});
const contentSchema = z.discriminatedUnion("type", [
    textContentSchema,
    imageReferenceSchema,
]);
const turnInputSchema = z.strictObject({
    content: z.array(contentSchema).min(1).max(16),
});
const turnOutputSchema = z.strictObject({
    content: z.array(contentSchema).min(1).max(16),
});

export type AgentIdentity = Readonly<{ id: string; version: string }>;
export type AgentTextContent = Readonly<{ type: "text"; text: string }>;
export type AgentImageReferenceContent = Readonly<{
    type: "image";
    resourceId: string;
}>;
export type AgentImageContent = Readonly<{
    type: "image";
    resource: AgentImageResource;
}>;
export type AgentTurnInputCandidate = Readonly<{
    content: readonly (AgentTextContent | AgentImageReferenceContent)[];
}>;
export type AcceptedAgentTurnInput = Readonly<{
    content: readonly (AgentTextContent | AgentImageContent)[];
}>;
export type AgentTurnOutputCandidate = AgentTurnInputCandidate;
export type AgentTurnOutput = AcceptedAgentTurnInput;

export type AgentRegistrationLimits = Readonly<{
    maxTurns: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    maxContextTokens: number;
    maxHistoryTurns: number;
    maxSummaryTokens: number;
    historyPageSize: number;
    maxImagesPerTurn: number;
    maxImageBytes: number;
    maxImageTotalBytes: number;
    maxImageWidth: number;
    maxImageHeight: number;
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
    | "INVALID_OUTPUT"
    | "RESOURCE_UNAVAILABLE";
export type AgentTurnCompletion =
    | Readonly<{ status: "succeeded"; output: AgentTurnOutput }>
    | Readonly<{
          status: "failed";
          error: Readonly<{ code: AgentTurnErrorCode; message: string }>;
      }>;
export type AgentTurnDraftCompletion =
    | Readonly<{ status: "succeeded"; output: AgentTurnOutputCandidate }>
    | Extract<AgentTurnCompletion, { status: "failed" }>;

export type InteractiveAgentRequest = Readonly<{
    conversationId: string;
    turnId: string;
    input: AcceptedAgentTurnInput;
    context: AgentConversationContext;
    imageAccess: readonly AgentImageAccess[];
    signal: AbortSignal;
}>;
export type InteractiveAgent = Readonly<{
    respond: (request: InteractiveAgentRequest) => Promise<unknown>;
}>;
export type AgentRegistrationAcceptance =
    | Readonly<{ accepted: true; acceptedInput: AgentTurnInputCandidate }>
    | Readonly<{ accepted: false }>;
export type AgentRegistration = Readonly<{
    identity: AgentIdentity;
    revision: string;
    limits: AgentRegistrationLimits;
    imageMediaTypes: readonly AgentImageMediaType[];
    accept: (input: unknown) => AgentRegistrationAcceptance;
    run: (
        request: InteractiveAgentRequest,
    ) => Promise<AgentTurnDraftCompletion>;
    [agentRegistrationBrand]: true;
}>;

export function defineAgentRegistration(options: {
    id: string;
    version: string;
    revision: string;
    agent: InteractiveAgent;
    limits?: Partial<AgentRegistrationLimits>;
    imageMediaTypes?: readonly AgentImageMediaType[];
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
    const imageTypes = defineImageMediaTypes(options.imageMediaTypes);
    return Object.freeze({
        identity: Object.freeze({ id: options.id, version: options.version }),
        revision: options.revision,
        limits,
        imageMediaTypes: imageTypes,
        accept: (input) => {
            const result = turnInputSchema.safeParse(input);
            return result.success &&
                textBytes(result.data.content) <= limits.maxInputBytes &&
                imageReferenceCount(result.data.content) <=
                    limits.maxImagesPerTurn
                ? Object.freeze({
                      accepted: true,
                      acceptedInput: freezeCandidate(result.data),
                  })
                : Object.freeze({ accepted: false });
        },
        run: async (request) => {
            let response: unknown;
            try {
                response = await options.agent.respond(
                    Object.freeze({
                        ...request,
                        input: structuredClone(request.input),
                        context: structuredClone(request.context),
                        imageAccess: Object.freeze(
                            request.imageAccess.map((item) =>
                                Object.freeze({ ...item }),
                            ),
                        ),
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
                textBytes(result.data.content) > limits.maxOutputBytes ||
                imageReferenceCount(result.data.content) >
                    limits.maxImagesPerTurn
            ) {
                return failed(
                    "INVALID_OUTPUT",
                    "The Agent produced an invalid output",
                );
            }
            return Object.freeze({
                status: "succeeded",
                output: freezeCandidate(result.data),
            });
        },
        [agentRegistrationBrand]: true as const,
    });
}

export async function resolveAgentTurnInput(
    candidate: AgentTurnInputCandidate,
    request: {
        ownerId: string;
        resolver?: AgentResourceResolver;
        registration: AgentRegistration;
    },
): Promise<AcceptedAgentTurnInput | undefined> {
    return resolveContent(candidate, {
        ownerId: request.ownerId,
        resolver: request.resolver,
        registration: request.registration,
        purpose: "input",
    });
}

export async function resolveAgentTurnCompletion(
    draft: AgentTurnDraftCompletion,
    request: {
        ownerId: string;
        turnId: string;
        resolver?: AgentResourceResolver;
        registration: AgentRegistration;
    },
): Promise<AgentTurnCompletion> {
    if (draft.status === "failed") return draft;
    const output = await resolveContent(draft.output, {
        ownerId: request.ownerId,
        turnId: request.turnId,
        resolver: request.resolver,
        registration: request.registration,
        purpose: "output",
    });
    return output
        ? Object.freeze({ status: "succeeded", output })
        : failed("INVALID_OUTPUT", "The Agent produced an invalid output");
}

function defineLimits(
    requested: Partial<AgentRegistrationLimits> | undefined,
): AgentRegistrationLimits {
    const limits: AgentRegistrationLimits = {
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
        maxImagesPerTurn:
            requested?.maxImagesPerTurn ?? globalAgentLimits.maxImagesPerTurn,
        maxImageBytes:
            requested?.maxImageBytes ?? globalAgentLimits.maxImageBytes,
        maxImageTotalBytes:
            requested?.maxImageTotalBytes ??
            globalAgentLimits.maxImageTotalBytes,
        maxImageWidth:
            requested?.maxImageWidth ?? globalAgentLimits.maxImageWidth,
        maxImageHeight:
            requested?.maxImageHeight ?? globalAgentLimits.maxImageHeight,
    };
    for (const [name, value] of Object.entries(limits)) {
        const globalName =
            name === "historyPageSize" ? "maxHistoryPageSize" : name;
        const globalLimit =
            globalAgentLimits[globalName as keyof typeof globalAgentLimits];
        if (!Number.isInteger(value) || value < 1 || value > globalLimit) {
            throw new Error(
                "Agent Registration " +
                    name +
                    " must be an integer between 1 and " +
                    globalLimit,
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
    if (limits.maxImageBytes > limits.maxImageTotalBytes) {
        throw new Error(
            "Agent Registration maxImageBytes must not exceed maxImageTotalBytes",
        );
    }
    return Object.freeze(limits);
}

function defineImageMediaTypes(
    requested: readonly AgentImageMediaType[] | undefined,
): readonly AgentImageMediaType[] {
    const selected = requested ?? agentImageMediaTypes;
    if (
        !Array.isArray(selected) ||
        selected.length === 0 ||
        new Set(selected).size !== selected.length ||
        selected.some((type) => !agentImageMediaTypes.includes(type))
    ) {
        throw new Error("Agent Registration image media types are invalid");
    }
    return Object.freeze([...selected]);
}

async function resolveContent(
    candidate: AgentTurnInputCandidate,
    request: {
        ownerId: string;
        turnId?: string;
        resolver?: AgentResourceResolver;
        registration: AgentRegistration;
        purpose: "input" | "output";
    },
): Promise<AcceptedAgentTurnInput | undefined> {
    const content: (AgentTextContent | AgentImageContent)[] = [];
    let totalImageBytes = 0;
    for (const block of candidate.content) {
        if (block.type === "text") {
            content.push(Object.freeze({ ...block }));
            continue;
        }
        if (!request.resolver) return undefined;
        const resource =
            request.purpose === "input"
                ? await request.resolver.inspectInput({
                      ownerId: request.ownerId,
                      resourceId: block.resourceId,
                  })
                : await request.resolver.inspectOutput({
                      ownerId: request.ownerId,
                      resourceId: block.resourceId,
                      turnId: request.turnId ?? "",
                  });
        if (
            !resource ||
            !request.registration.imageMediaTypes.includes(
                resource.mediaType,
            ) ||
            resource.byteSize > request.registration.limits.maxImageBytes ||
            resource.width > request.registration.limits.maxImageWidth ||
            resource.height > request.registration.limits.maxImageHeight
        ) {
            return undefined;
        }
        totalImageBytes += resource.byteSize;
        if (totalImageBytes > request.registration.limits.maxImageTotalBytes) {
            return undefined;
        }
        content.push(
            Object.freeze({
                type: "image",
                resource: structuredClone(resource),
            }),
        );
    }
    return Object.freeze({ content: Object.freeze(content) });
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

function textBytes(
    content: readonly (AgentTextContent | AgentImageReferenceContent)[],
): number {
    return content.reduce(
        (total, block) =>
            total +
            (block.type === "text" ? Buffer.byteLength(block.text, "utf8") : 0),
        0,
    );
}
function imageReferenceCount(
    content: readonly (AgentTextContent | AgentImageReferenceContent)[],
): number {
    return content.filter((block) => block.type === "image").length;
}
function freezeCandidate(input: {
    content: readonly (AgentTextContent | AgentImageReferenceContent)[];
}): AgentTurnInputCandidate {
    return Object.freeze({
        content: Object.freeze(
            input.content.map((block) => Object.freeze({ ...block })),
        ),
    });
}
function failed(
    code: AgentTurnErrorCode,
    message: string,
): Extract<AgentTurnCompletion, { status: "failed" }> {
    return Object.freeze({
        status: "failed",
        error: Object.freeze({ code, message }),
    });
}
