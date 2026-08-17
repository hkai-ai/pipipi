import { createInstalledSkillCatalog } from "../agent-runtime/catalog.js";
import type { SkillRef } from "../agent-runtime/skills.js";
import { createContentSkillRefs } from "../processes/content/skills.js";
import { createCrtSkillRefs } from "../processes/crt/skills.js";
import {
    createNarrativeMonumentSkillRefs,
    createPaleWatercolorSkillRefs,
    createRawHumanismSkillRefs,
} from "../processes/news-image/skills.js";
import { createPosterSkillRefs } from "../processes/poster/skills.js";
import type { StartupEnvironment } from "./config.js";

export type ProductionSkillBindings = Readonly<{
    content: readonly SkillRef[];
    poster: readonly SkillRef[];
    crt: readonly SkillRef[];
    paleWatercolor: readonly SkillRef[];
    rawHumanism: readonly SkillRef[];
    narrativeMonument: readonly SkillRef[];
}>;

/** Validates all bundled Runtime Skills and returns exact Process bindings. */
export function createProductionSkillBindings(
    environment: StartupEnvironment,
    cwd = process.cwd(),
): ProductionSkillBindings {
    const content = createContentSkillRefs({
        optimizationPath: environment.PI_SKILL_DIRECTORY,
    });
    const poster = createPosterSkillRefs({
        path: environment.PI_POSTER_SKILL_DIRECTORY,
    });
    const crt = createCrtSkillRefs({
        path: environment.PI_CRT_SKILL_DIRECTORY,
    });
    const paleWatercolor = createPaleWatercolorSkillRefs({
        path: environment.PI_PALE_WATERCOLOR_SKILL_DIRECTORY,
    });
    const rawHumanism = createRawHumanismSkillRefs({
        path: environment.PI_RAW_HUMANISM_SKILL_DIRECTORY,
    });
    const narrativeMonument = createNarrativeMonumentSkillRefs({
        path: environment.PI_NARRATIVE_MONUMENT_SKILL_DIRECTORY,
    });
    const catalog = createInstalledSkillCatalog(
        [
            ...content,
            ...poster,
            ...crt,
            ...paleWatercolor,
            ...rawHumanism,
            ...narrativeMonument,
        ],
        cwd,
    );

    return Object.freeze({
        content: catalog.resolve(content),
        poster: catalog.resolve(poster),
        crt: catalog.resolve(crt),
        paleWatercolor: catalog.resolve(paleWatercolor),
        rawHumanism: catalog.resolve(rawHumanism),
        narrativeMonument: catalog.resolve(narrativeMonument),
    });
}
