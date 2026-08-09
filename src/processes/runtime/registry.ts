import {
    assertProcessIdentity,
    type ProcessIdentity,
    type ProcessRegistration,
    processRegistrationBrand,
} from "./registration.js";

export const processRegistryBrand: unique symbol = Symbol("ProcessRegistry");

export type ProcessRegistry = Readonly<{
    find: (identity: ProcessIdentity) => ProcessRegistration | undefined;
    [processRegistryBrand]: true;
}>;

export function createProcessRegistry(
    registrations: readonly ProcessRegistration[],
): ProcessRegistry {
    const registrationsById = new Map<
        string,
        Map<string, ProcessRegistration>
    >();

    for (const registration of registrations) {
        if (
            typeof registration !== "object" ||
            registration === null ||
            registration[processRegistrationBrand] !== true
        ) {
            throw new Error(
                "Process Registry accepts only Process Registrations",
            );
        }
        assertProcessIdentity(registration.identity);
        let versions = registrationsById.get(registration.identity.id);
        if (!versions) {
            versions = new Map();
            registrationsById.set(registration.identity.id, versions);
        }
        if (versions.has(registration.identity.version)) {
            throw new Error(
                `Process ${registration.identity.id}/${registration.identity.version} is registered more than once`,
            );
        }
        versions.set(registration.identity.version, registration);
    }

    return Object.freeze({
        find: (identity: ProcessIdentity) =>
            registrationsById.get(identity.id)?.get(identity.version),
        [processRegistryBrand]: true as const,
    });
}
