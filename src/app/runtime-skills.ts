/** 由 production catalog 派生的 Runtime Skill 安装集合、启动完整性校验和精确 Process 绑定 */
import { createInstalledSkillCatalog } from "../agent-runtime/catalog.js";
import type { InstalledSkillRef } from "../agent-runtime/skills.js";
import { productionCatalog } from "../processes/catalog.js";
import {
    enabledProductionProcesses,
    type ProductionProcess,
    type ProductionSkillBindings,
} from "../processes/production.js";
import type { StartupEnvironment } from "./config.js";

/**
 * Validates every Runtime Skill the enabled production catalog declares and
 * returns exact per-Process bindings. API, Process Worker and deployment
 * preflight all run this before any Adapter exists; a Process the environment
 * switches off contributes nothing, so its Skills need not ship.
 */
export function createProductionSkillBindings(
    environment: StartupEnvironment,
    cwd = process.cwd(),
    processes: readonly ProductionProcess[] = productionCatalog,
): ProductionSkillBindings {
    const declared = enabledProductionProcesses(processes, environment)
        .map((process) => ({
            process,
            refs: process.installedSkills(environment),
        }))
        .filter(({ refs }) => refs.length > 0);
    if (declared.length === 0) return new Map();
    const catalog = createInstalledSkillCatalog(
        uniqueInstalled(declared.flatMap(({ refs }) => refs)),
        cwd,
    );
    return new Map(
        declared.map(({ process, refs }) => [process, catalog.resolve(refs)]),
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
