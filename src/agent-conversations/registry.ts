/** 按准确 id/version 索引不可变 Agent Registration 集合 */
import {
    type AgentIdentity,
    type AgentRegistration,
    agentRegistrationBrand,
    assertAgentIdentity,
} from "./registration.js";

export type AgentRegistry = Readonly<{
    find: (identity: AgentIdentity) => AgentRegistration | undefined;
    list: () => readonly AgentRegistration[];
}>;

export function createAgentRegistry(
    registrations: readonly AgentRegistration[],
): AgentRegistry {
    const byIdentity = new Map<string, AgentRegistration>();
    for (const registration of registrations) {
        if (
            typeof registration !== "object" ||
            registration === null ||
            registration[agentRegistrationBrand] !== true
        ) {
            throw new Error("Agent Registry accepts only Agent Registrations");
        }
        assertAgentIdentity(registration.identity);
        const key = identityKey(registration.identity);
        if (byIdentity.has(key)) {
            throw new Error(
                `Agent ${registration.identity.id}/${registration.identity.version} is registered more than once`,
            );
        }
        byIdentity.set(key, registration);
    }
    const ordered = Object.freeze(
        [...registrations].sort((left, right) =>
            identityKey(left.identity).localeCompare(
                identityKey(right.identity),
            ),
        ),
    );
    return Object.freeze({
        find: (identity) => byIdentity.get(identityKey(identity)),
        list: () => ordered,
    });
}

function identityKey(identity: AgentIdentity): string {
    return `${identity.id}\u0000${identity.version}`;
}
