/** 显式构造不可运行时扩展的 production Agent catalog */

import {
    type AgentRegistry,
    createAgentRegistry,
} from "../agent-conversations/registry.js";
import type {
    ProcessAttemptRunner,
    ProcessRegistry,
} from "../process-runtime/index.js";
import {
    createDesignAssistantRuntime,
    type DesignAssistantEnvironment,
    type DesignAssistantRuntime,
    designAssistantIdentity,
} from "./design-assistant.js";

export const productionAgentCatalog = Object.freeze([designAssistantIdentity]);

export type ProductionAgentRuntime = Readonly<{
    registry: AgentRegistry;
    designAssistant: DesignAssistantRuntime;
    ready: () => Promise<void>;
}>;

export function createProductionAgentRuntime(options: {
    environment: DesignAssistantEnvironment;
    processRegistry: ProcessRegistry;
    attemptRunner: ProcessAttemptRunner;
    cwd?: string;
    retainedRegistrations?: Parameters<typeof createAgentRegistry>[1];
}): ProductionAgentRuntime {
    const designAssistant = createDesignAssistantRuntime(options);
    const registrations = [designAssistant.registration];
    if (
        registrations.length !== productionAgentCatalog.length ||
        registrations.some(
            (registration, index) =>
                registration.identity.id !==
                    productionAgentCatalog[index]?.id ||
                registration.identity.version !==
                    productionAgentCatalog[index]?.version,
        )
    ) {
        throw new Error(
            "Production Agent catalog does not match its Registrations",
        );
    }
    const registry = createAgentRegistry(
        registrations,
        options.retainedRegistrations,
    );
    return Object.freeze({
        registry,
        designAssistant,
        ready: designAssistant.ready,
    });
}
