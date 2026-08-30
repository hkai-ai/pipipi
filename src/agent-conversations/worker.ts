/** 从最小 Agent Turn Job 认领 Turn，以 lease 和 fencing 执行并提交公共终态 */

import { randomUUID } from "node:crypto";
import type { JsonValue } from "../process-runtime/index.js";
import { assembleAgentConversationContext } from "./context.js";
import { type AgentTurnSource, parseAgentTurnJob } from "./queue.js";
import {
    type AcceptedAgentTurnInput,
    type AgentConversationContext,
    type AgentRegistration,
    type AgentTurnCompletion,
    resolveAgentTurnCompletion,
} from "./registration.js";
import type { AgentRegistry } from "./registry.js";
import type {
    AcquiredAgentImage,
    AgentImageResource,
    AgentResourceResolver,
} from "./resource.js";
import {
    type AgentConversationStore,
    type ClaimedAgentTurn,
    isRecoverableAgentConversationStore,
    type StartedAgentTurn,
} from "./store.js";
import {
    type AgentProcessTool,
    type AgentToolLedger,
    type BoundAgentProcessTools,
    createInMemoryAgentToolLedger,
    isAgentOutputDerivedFromTools,
} from "./tools.js";

export type AgentTurnWorker = Readonly<{
    process: (
        job: unknown,
        context?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<"processed" | "ignored" | "invalid-job">;
    releaseActive: (request: { releasedAt: string }) => Promise<number>;
}>;

export type AgentTurnActivity = Readonly<{
    schemaVersion: 1;
    event: "agent_turn_started" | "agent_turn_finished";
    conversationId: string;
    turnId: string;
    agentId: string;
    agentVersion: string;
    configRevision: string;
    attemptNumber?: number;
    outcome?: "succeeded" | "failed" | "ignored";
    errorCode?: string;
    durationMs?: number;
    timestamp: string;
}>;

export function createAgentTurnWorker(options: {
    registry: AgentRegistry;
    store: AgentConversationStore;
    resourceResolver?: AgentResourceResolver;
    toolLedger?: AgentToolLedger;
    clock?: () => string;
    createClaimToken?: () => string;
    timeoutMs?: number;
    logSink?: (activity: AgentTurnActivity) => void;
}): AgentTurnWorker {
    const clock = options.clock ?? (() => new Date().toISOString());
    const createClaimToken = options.createClaimToken ?? randomUUID;
    const toolLedger = options.toolLedger ?? createInMemoryAgentToolLedger();
    const timeoutMs = positiveInteger(
        options.timeoutMs ?? 120_000,
        "Agent Turn timeout",
    );
    const activeClaims = new Map<
        string,
        Readonly<{ turnId: string; claimToken: string }>
    >();
    return Object.freeze({
        process: async (rawJob, context) => {
            const job = parseAgentTurnJob(rawJob);
            if (!job) return "invalid-job";
            if (context?.signal?.aborted) return "ignored";
            if (isRecoverableAgentConversationStore(options.store)) {
                const claim = await options.store.claim({
                    turnId: job.turnId,
                    claimToken: createClaimToken(),
                    claimedAt: clock(),
                });
                if (!claim) return "ignored";
                activeClaims.set(claim.claimToken, {
                    turnId: claim.turnId,
                    claimToken: claim.claimToken,
                });
                const startedAt = Date.now();
                writeActivity(options.logSink, {
                    schemaVersion: 1,
                    event: "agent_turn_started",
                    conversationId: claim.conversationId,
                    turnId: claim.turnId,
                    agentId: claim.agent.id,
                    agentVersion: claim.agent.version,
                    configRevision: claim.configRevision,
                    attemptNumber: claim.attemptNumber,
                    timestamp: clock(),
                });
                try {
                    if (context?.signal?.aborted) {
                        await options.store.releaseClaim({
                            turnId: claim.turnId,
                            claimToken: claim.claimToken,
                            releasedAt: clock(),
                        });
                        finishActivity(claim, startedAt, "ignored");
                        return "ignored";
                    }
                    const completion = await completionFor(
                        claim,
                        boundedSignal(context?.signal, timeoutMs),
                    );
                    if (context?.signal?.aborted) {
                        await options.store.releaseClaim({
                            turnId: claim.turnId,
                            claimToken: claim.claimToken,
                            releasedAt: clock(),
                        });
                        finishActivity(claim, startedAt, "ignored");
                        return "ignored";
                    }
                    const completed = await options.store.completeClaim({
                        turnId: claim.turnId,
                        claimToken: claim.claimToken,
                        completedAt: clock(),
                        completion,
                    });
                    finishActivity(
                        claim,
                        startedAt,
                        completed
                            ? completion.status === "succeeded"
                                ? "succeeded"
                                : "failed"
                            : "ignored",
                        completion.status === "failed"
                            ? completion.error.code
                            : undefined,
                    );
                    return completed ? "processed" : "ignored";
                } catch (error) {
                    finishActivity(
                        claim,
                        startedAt,
                        "failed",
                        "INTERNAL_ERROR",
                    );
                    throw error;
                } finally {
                    activeClaims.delete(claim.claimToken);
                }
            }
            const started = await options.store.start({
                turnId: job.turnId,
                startedAt: clock(),
            });
            if (!started) return "ignored";
            const completion = await completionFor(
                started,
                boundedSignal(context?.signal, timeoutMs),
            );
            const completed = await options.store.complete({
                turnId: started.turnId,
                completedAt: clock(),
                completion,
            });
            return completed ? "processed" : "ignored";
        },
        releaseActive: async (request) => {
            if (!isRecoverableAgentConversationStore(options.store)) return 0;
            const store = options.store;
            const released = await Promise.all(
                [...activeClaims.values()].map((claim) =>
                    store.releaseClaim({
                        turnId: claim.turnId,
                        claimToken: claim.claimToken,
                        releasedAt: request.releasedAt,
                    }),
                ),
            );
            return released.filter(Boolean).length;
        },
    });

    function finishActivity(
        turn: ClaimedAgentTurn,
        startedAt: number,
        outcome: "succeeded" | "failed" | "ignored",
        errorCode?: string,
    ): void {
        writeActivity(options.logSink, {
            schemaVersion: 1,
            event: "agent_turn_finished",
            conversationId: turn.conversationId,
            turnId: turn.turnId,
            agentId: turn.agent.id,
            agentVersion: turn.agent.version,
            configRevision: turn.configRevision,
            attemptNumber: turn.attemptNumber,
            outcome,
            ...(errorCode ? { errorCode } : {}),
            durationMs: Math.max(0, Date.now() - startedAt),
            timestamp: clock(),
        });
    }

    async function completionFor(
        started: StartedAgentTurn | ClaimedAgentTurn,
        signal: AbortSignal,
    ): Promise<AgentTurnCompletion> {
        const registration = options.registry.findRevision(
            started.agent,
            started.configRevision,
        );
        return registration
            ? executeAgentTurn(
                  started,
                  registration,
                  options.resourceResolver,
                  toolLedger,
                  signal,
              )
            : {
                  status: "failed",
                  error: {
                      code: "INTERNAL_ERROR",
                      message: "The Agent Turn could not be completed",
                  },
              };
    }
}

function writeActivity(
    sink: ((activity: AgentTurnActivity) => void) | undefined,
    activity: AgentTurnActivity,
): void {
    try {
        sink?.(Object.freeze(activity));
    } catch {
        // Observability cannot change Agent execution.
    }
}

function boundedSignal(
    signal: AbortSignal | undefined,
    timeoutMs: number,
): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

async function executeAgentTurn(
    started: StartedAgentTurn,
    registration: AgentRegistration,
    resolver: AgentResourceResolver | undefined,
    toolLedger: AgentToolLedger,
    signal: AbortSignal,
): Promise<AgentTurnCompletion> {
    const acquired: AcquiredAgentImage[] = [];
    let records: readonly ReturnType<AgentToolLedger["records"]>[number][] = [];
    let boundTools: BoundAgentProcessTools | undefined;
    try {
        const context = assembleAgentConversationContext(
            started.priorTurns,
            started.input,
            registration.limits,
        );
        const resources = imageResources(started.input, context);
        for (const resource of resources) {
            const image = resolver
                ? await resolver.acquire({
                      ownerId: started.ownerId,
                      resource,
                      signal,
                  })
                : undefined;
            if (!image) return resourceUnavailable();
            acquired.push(image);
        }
        boundTools = registration.processToolRuntime
            ? toolLedger.bind({
                  conversationId: started.conversationId,
                  turnId: started.turnId,
                  runtime: registration.processToolRuntime,
                  limits: registration.toolLimits,
                  signal,
              })
            : undefined;
        const draft = await registration.run({
            conversationId: started.conversationId,
            turnId: started.turnId,
            input: started.input,
            context,
            imageAccess: Object.freeze(acquired.map((image) => image.access)),
            processTools: publishPricedToolOutputs(
                boundTools?.tools ?? [],
                registration,
                resolver,
                started,
            ),
            maxToolCalls: registration.toolLimits.maxCallsPerTurn,
            signal,
        });
        records = boundTools?.records() ?? [];
        if (boundTools && !isAgentOutputDerivedFromTools(draft, records)) {
            return protectPricedCommit(invalidOutput(), records);
        }
        return protectPricedCommit(
            await resolveAgentTurnCompletion(draft, {
                ownerId: started.ownerId,
                turnId: started.turnId,
                resolver,
                registration,
            }),
            records,
        );
    } catch {
        records = boundTools?.records() ?? records;
        return protectPricedCommit(resourceUnavailable(), records);
    } finally {
        await Promise.allSettled(
            acquired.reverse().map((image) => image.release()),
        );
    }
}

function publishPricedToolOutputs(
    tools: readonly AgentProcessTool[],
    registration: AgentRegistration,
    resolver: AgentResourceResolver | undefined,
    turn: StartedAgentTurn,
): readonly AgentProcessTool[] {
    if (!resolver?.publishProcessOutput) return tools;
    const publisher = resolver.publishProcessOutput;
    const priced = new Set(
        registration.processToolRuntime?.specs
            .filter((spec) => spec.sideEffect === "priced")
            .map((spec) => spec.toolName) ?? [],
    );
    return Object.freeze(
        tools.map((tool) =>
            priced.has(tool.name)
                ? Object.freeze({
                      ...tool,
                      execute: async (input: unknown) => {
                          const result = await tool.execute(input);
                          if (!isSuccessfulToolResult(result)) return result;
                          const published = jsonValue(
                              await publisher({
                                  ownerId: turn.ownerId,
                                  turnId: turn.turnId,
                                  toolName: tool.name,
                                  result,
                              }),
                          );
                          if (!sameToolResultIdentity(result, published)) {
                              throw new Error(
                                  "Published Process Tool output is invalid",
                              );
                          }
                          return published;
                      },
                  })
                : tool,
        ),
    );
}

function isSuccessfulToolResult(
    value: unknown,
): value is Readonly<Record<string, unknown>> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).status === "succeeded"
    );
}

function sameToolResultIdentity(
    original: Readonly<Record<string, unknown>>,
    published: JsonValue,
): boolean {
    if (!isSuccessfulToolResult(published)) return false;
    return ["invocation", "process", "version"].every(
        (key) => published[key] === original[key],
    );
}

function jsonValue(value: unknown): JsonValue {
    const serialized = JSON.stringify(value);
    if (
        serialized === undefined ||
        Buffer.byteLength(serialized, "utf8") > 262_144
    ) {
        throw new Error("Published Process Tool output is invalid");
    }
    return JSON.parse(serialized) as JsonValue;
}

function protectPricedCommit(
    completion: AgentTurnCompletion,
    records: readonly ReturnType<AgentToolLedger["records"]>[number][],
): AgentTurnCompletion {
    if (
        completion.status === "failed" &&
        records.some(
            (record) =>
                record.sideEffect === "priced" &&
                (record.status === "succeeded" ||
                    record.error?.code === "DEPENDENCY_FAILURE_AFTER_COMMIT"),
        )
    ) {
        return Object.freeze({
            status: "failed",
            error: Object.freeze({
                code: "DEPENDENCY_FAILURE_AFTER_COMMIT",
                message:
                    "A priced dependency completed but the Turn could not be completed",
            }),
        });
    }
    return completion;
}

function invalidOutput(): AgentTurnCompletion {
    return Object.freeze({
        status: "failed",
        error: Object.freeze({
            code: "INVALID_OUTPUT",
            message: "The Agent produced an invalid output",
        }),
    });
}

function imageResources(
    input: AcceptedAgentTurnInput,
    context: AgentConversationContext,
): readonly AgentImageResource[] {
    const resources = new Map<string, AgentImageResource>();
    const collect = (value: AcceptedAgentTurnInput) => {
        for (const block of value.content) {
            if (block.type === "image") {
                const existing = resources.get(block.resource.resourceId);
                if (existing && !sameImageResource(existing, block.resource)) {
                    throw new Error("Agent image resource metadata changed");
                }
                resources.set(block.resource.resourceId, block.resource);
            }
        }
    };
    collect(input);
    for (const turn of context.history) {
        collect(turn.input);
        collect(turn.output);
    }
    return Object.freeze(
        [...resources.values()].map((resource) => structuredClone(resource)),
    );
}

function sameImageResource(
    left: AgentImageResource,
    right: AgentImageResource,
): boolean {
    return (
        left.resourceId === right.resourceId &&
        left.mediaType === right.mediaType &&
        left.byteSize === right.byteSize &&
        left.width === right.width &&
        left.height === right.height
    );
}

function resourceUnavailable(): AgentTurnCompletion {
    return Object.freeze({
        status: "failed",
        error: Object.freeze({
            code: "RESOURCE_UNAVAILABLE",
            message: "An Agent resource was unavailable",
        }),
    });
}

export type AgentTurnDrain = Readonly<{
    drainOne: () => Promise<"processed" | "ignored" | "invalid-job" | "empty">;
}>;

export function createAgentTurnDrain(options: {
    source: AgentTurnSource;
    worker: AgentTurnWorker;
}): AgentTurnDrain {
    return Object.freeze({
        drainOne: async () => {
            const job = await options.source.take();
            return job ? options.worker.process(job) : "empty";
        },
    });
}
