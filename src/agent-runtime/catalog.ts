import { resolve } from "node:path";
import {
    createSkillSet,
    type InstalledSkillRef,
    type SkillRef,
} from "./skills.js";

export type SkillRequirement = Readonly<{
    name: string;
    version: string;
}>;

export type InstalledSkillInfo = Readonly<{
    name: string;
    version: string;
    sha256: string;
}>;

export type InstalledSkillCatalog = Readonly<{
    resolve: (requirements: readonly SkillRequirement[]) => readonly SkillRef[];
    list: () => readonly InstalledSkillInfo[];
}>;

/**
 * Validates every server-owned Runtime Skill at startup and resolves only exact
 * name/version requirements. It never discovers, downloads, or updates Skills.
 */
export function createInstalledSkillCatalog(
    installed: readonly InstalledSkillRef[],
    cwd: string,
): InstalledSkillCatalog {
    if (!Array.isArray(installed) || installed.length === 0) {
        throw new Error("At least one installed Runtime Skill is required");
    }

    const byIdentity = new Map<string, InstalledSkillRef>();
    const paths = new Set<string>();
    for (const candidate of installed) {
        const path = resolve(cwd, candidate.path);
        const identity = formatIdentity(candidate);
        if (byIdentity.has(identity)) {
            throw new Error(
                `Installed Runtime Skill "${identity}" is duplicated`,
            );
        }
        if (paths.has(path)) {
            throw new Error(
                `Installed Runtime Skill path "${path}" is duplicated`,
            );
        }

        const fixed = Object.freeze({ ...candidate, path });
        createSkillSet([fixed], cwd).load();
        byIdentity.set(identity, fixed);
        paths.add(path);
    }

    const info = Object.freeze(
        [...byIdentity.values()]
            .map(({ name, version, sha256 }) =>
                Object.freeze({ name, version, sha256 }),
            )
            .sort((left, right) =>
                formatIdentity(left).localeCompare(formatIdentity(right)),
            ),
    );

    return Object.freeze({
        resolve: (requirements) => {
            if (!Array.isArray(requirements) || requirements.length === 0) {
                throw new Error(
                    "At least one Runtime Skill requirement is required",
                );
            }
            const names = new Set<string>();
            const refs = requirements.map((requirement) => {
                if (names.has(requirement.name)) {
                    throw new Error(
                        `Runtime Skill requirement "${requirement.name}" is duplicated`,
                    );
                }
                names.add(requirement.name);
                const identity = formatIdentity(requirement);
                const ref = byIdentity.get(identity);
                if (!ref) {
                    throw new Error(
                        `Installed Runtime Skill "${identity}" is unavailable`,
                    );
                }
                return ref;
            });
            return Object.freeze(refs);
        },
        list: () => info,
    });
}

function formatIdentity(requirement: SkillRequirement): string {
    return `${requirement.name}@${requirement.version}`;
}
