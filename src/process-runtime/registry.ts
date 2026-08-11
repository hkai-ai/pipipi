import {
    assertProcessIdentity,
    type ProcessIdentity,
    type ProcessRegistration,
    processRegistrationBrand,
} from "./registration.js";

export const processRegistryBrand: unique symbol = Symbol("ProcessRegistry");

export type ProcessRegistry = Readonly<{
    find: (identity: ProcessIdentity) => ProcessRegistration | undefined;
    /**
     * Every registered Process version, ordered by id then version. The
     * production catalog is fixed at construction, so this is a stable
     * description of what this release can execute.
     */
    list: () => readonly ProcessRegistration[];
    [processRegistryBrand]: true;
}>;

function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

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

    const ordered = Object.freeze(
        [...registrations].sort(
            (left, right) =>
                compare(left.identity.id, right.identity.id) ||
                compare(left.identity.version, right.identity.version),
        ),
    );

    return Object.freeze({
        find: (identity: ProcessIdentity) =>
            registrationsById.get(identity.id)?.get(identity.version),
        list: () => ordered,
        [processRegistryBrand]: true as const,
    });
}
