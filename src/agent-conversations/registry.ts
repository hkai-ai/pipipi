/** 按准确 id/version 索引不可变 Agent Registration 集合 */
import {
    type AgentIdentity,
    type AgentRegistration,
    agentRegistrationBrand,
    assertAgentIdentity,
} from "./registration.js";

export type AgentRegistry = Readonly<{
    find: (identity: AgentIdentity) => AgentRegistration | undefined;
    findRevision: (
        identity: AgentIdentity,
        revision: string,
    ) => AgentRegistration | undefined;
    list: () => readonly AgentRegistration[];
}>;

export function createAgentRegistry(
    registrations: readonly AgentRegistration[],
    options: { retained?: readonly AgentRegistration[] } = {},
): AgentRegistry {
    const byIdentity = new Map<string, AgentRegistration>();
    const byRevision = new Map<string, AgentRegistration>();
    for (const registration of registrations) {
        assertRegistration(registration);
        const key = identityKey(registration.identity);
        if (byIdentity.has(key)) {
            throw new Error(
                `Agent ${registration.identity.id}/${registration.identity.version} is registered more than once`,
            );
        }
        byIdentity.set(key, registration);
        byRevision.set(revisionKey(registration), registration);
    }
    for (const registration of options.retained ?? []) {
        assertRegistration(registration);
        const identity = identityKey(registration.identity);
        if (!byIdentity.has(identity)) {
            throw new Error(
                "A retained Agent Registration requires a current identity",
            );
        }
        const key = revisionKey(registration);
        if (byRevision.has(key)) {
            throw new Error(
                `Agent ${registration.identity.id}/${registration.identity.version} revision ${registration.revision} is registered more than once`,
            );
        }
        byRevision.set(key, registration);
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
        findRevision: (identity, revision) =>
            byRevision.get(`${identityKey(identity)}\u0000${revision}`),
        list: () => ordered,
    });
}

function assertRegistration(registration: AgentRegistration): void {
    if (
        typeof registration !== "object" ||
        registration === null ||
        registration[agentRegistrationBrand] !== true
    ) {
        throw new Error("Agent Registry accepts only Agent Registrations");
    }
    assertAgentIdentity(registration.identity);
}

function identityKey(identity: AgentIdentity): string {
    return `${identity.id}\u0000${identity.version}`;
}

function revisionKey(registration: AgentRegistration): string {
    return `${identityKey(registration.identity)}\u0000${registration.revision}`;
}
