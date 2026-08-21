/** 由 production catalog 派生的 Runtime Skill 安装集合、启动完整性校验和精确 Process 绑定 */
import { createInstalledSkillCatalog } from "../agent-runtime/catalog.js";
import type { InstalledSkillRef, SkillRef } from "../agent-runtime/skills.js";
import { productionCatalog } from "../processes/catalog.js";
import type { StartupEnvironment } from "./config.js";

/** Resolved Skill refs keyed by Process id; Processes without Skills are absent. */
export type ProductionSkillBindings = Readonly<
    Record<string, readonly SkillRef[]>
>;

/**
 * Validates every Runtime Skill the production catalog declares and returns
 * exact per-Process bindings. API, Process Worker and deployment preflight all
 * run this before any Adapter exists.
 */
export function createProductionSkillBindings(
    environment: StartupEnvironment,
    cwd = process.cwd(),
): ProductionSkillBindings {
    const declared = productionCatalog
        .map((process) => ({
            id: process.id,
            refs: process.installedSkills(environment),
        }))
        .filter(({ refs }) => refs.length > 0);
    const catalog = createInstalledSkillCatalog(
        uniqueInstalled(declared.flatMap(({ refs }) => refs)),
        cwd,
    );
    return Object.freeze(
        Object.fromEntries(
            declared.map(({ id, refs }) => [id, catalog.resolve(refs)]),
        ),
    );
}

/**
 * Two Processes may install the very same Skill; the Catalog still rejects the
 * same identity with a different path or digest.
 */
function uniqueInstalled(
    refs: readonly InstalledSkillRef[],
): readonly InstalledSkillRef[] {
    const seen = new Set<string>();
    return refs.filter((ref) => {
        const key = `${ref.name}@${ref.version}|${ref.sha256}|${ref.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
