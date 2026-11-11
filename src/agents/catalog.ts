/** 显式构造不可运行时扩展的 production Agent catalog，并持有 Conversation 保留期策略 */

import type { AgentRegistration } from "../agent-conversations/registration.js";
import {
    type AgentRegistry,
    createAgentRegistry,
} from "../agent-conversations/registry.js";
import type {
    ProcessAttemptRunner,
    ProcessRegistry,
} from "../process-runtime/index.js";

/** Idle Conversations expire after 30 days; deletion then waits one more day. */
export const agentConversationRetentionMs = 30 * 24 * 60 * 60 * 1_000;
export const agentConversationDeletionGraceMs = 24 * 60 * 60 * 1_000;

export type ProductionAgentOptions = Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    processRegistry: ProcessRegistry;
    attemptRunner: ProcessAttemptRunner;
    cwd?: string;
}>;

/** One production Agent as the explicit catalog builds it. */
export type ProductionAgent = Readonly<{
    registration: AgentRegistration;
    ready: () => Promise<void>;
}>;

/**
 * The reviewed production Agents. The former design-assistant/v1 was removed
 * until it is redeveloped; add its factory here when it returns.
 */
const productionAgents: readonly ((
    options: ProductionAgentOptions,
) => ProductionAgent)[] = Object.freeze([]);

export type ProductionAgentRuntime = Readonly<{
    registry: AgentRegistry;
    ready: () => Promise<void>;
}>;

export function createProductionAgentRuntime(
    options: ProductionAgentOptions & {
        retainedRegistrations?: Parameters<typeof createAgentRegistry>[1];
    },
): ProductionAgentRuntime {
    if (productionAgents.length === 0) {
        throw new Error(
            "No production Agent is registered; keep AGENT_CONVERSATIONS_ENABLED=false",
        );
    }
    const agents = productionAgents.map((create) => create(options));
    const registry = createAgentRegistry(
        agents.map((agent) => agent.registration),
        options.retainedRegistrations,
    );
    return Object.freeze({
        registry,
        ready: async () => {
            await Promise.all(agents.map((agent) => agent.ready()));
        },
    });
}
