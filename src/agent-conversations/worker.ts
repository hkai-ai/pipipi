/** 从最小 Agent Turn Job 认领 Turn，装配受预算 Context 并提交公共终态 */

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
import type { AgentConversationStore, StartedAgentTurn } from "./store.js";
import {
    type AgentToolLedger,
    createInMemoryAgentToolLedger,
    isAgentOutputDerivedFromTools,
} from "./tools.js";

export type AgentTurnWorker = Readonly<{
    process: (job: unknown) => Promise<"processed" | "ignored" | "invalid-job">;
}>;

export function createAgentTurnWorker(options: {
    registry: AgentRegistry;
    store: AgentConversationStore;
    resourceResolver?: AgentResourceResolver;
    toolLedger?: AgentToolLedger;
    clock?: () => string;
}): AgentTurnWorker {
    const clock = options.clock ?? (() => new Date().toISOString());
    const toolLedger = options.toolLedger ?? createInMemoryAgentToolLedger();
    return Object.freeze({
        process: async (rawJob) => {
            const job = parseAgentTurnJob(rawJob);
            if (!job) return "invalid-job";
            const started = await options.store.start({
                turnId: job.turnId,
                startedAt: clock(),
            });
            if (!started) return "ignored";

            const registration = options.registry.find(started.agent);
            const completion: AgentTurnCompletion =
                registration?.revision === started.configRevision
                    ? await executeAgentTurn(
                          started,
                          registration,
                          options.resourceResolver,
                          toolLedger,
                      )
                    : {
                          status: "failed" as const,
                          error: {
                              code: "INTERNAL_ERROR" as const,
                              message: "The Agent Turn could not be completed",
                          },
                      };
            const completed = await options.store.complete({
                turnId: started.turnId,
                completedAt: clock(),
                completion,
            });
            return completed ? "processed" : "ignored";
        },
    });
}

async function executeAgentTurn(
    started: StartedAgentTurn,
    registration: AgentRegistration,
    resolver: AgentResourceResolver | undefined,
    toolLedger: AgentToolLedger,
): Promise<AgentTurnCompletion> {
    const signal = new AbortController().signal;
    const acquired: AcquiredAgentImage[] = [];
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
        const boundTools = registration.processToolRuntime
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
            processTools: boundTools?.tools ?? [],
            maxToolCalls: registration.toolLimits.maxCallsPerTurn,
            signal,
        });
        if (
            boundTools &&
            !isAgentOutputDerivedFromTools(draft, boundTools.records())
        ) {
            return invalidOutput();
        }
        return await resolveAgentTurnCompletion(draft, {
            ownerId: started.ownerId,
            turnId: started.turnId,
            resolver,
            registration,
        });
    } catch {
        return resourceUnavailable();
    } finally {
        await Promise.allSettled(
            acquired.reverse().map((image) => image.release()),
        );
    }
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
