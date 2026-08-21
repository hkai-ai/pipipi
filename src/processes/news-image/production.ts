/** 三个新闻图片 Process 的生产装配：按固定风格绑定 Skill、Pi Agent 和 CRT Business API 的 POST /news-images */
import { parseCrtBusinessApiBaseUrl } from "../crt/production.js";
import {
    defineProductionProcess,
    type ProductionEnvironment,
    type ProductionProcess,
} from "../production.js";
import { PiNewsImageAgent } from "./agent.pi.js";
import { HttpNewsImageRenderingCapability } from "./capability.http.js";
import type { NewsImageStyle } from "./capability.js";
import { createNewsImageRegistration } from "./registration.js";
import {
    createNarrativeMonumentSkillRefs,
    createPaleWatercolorSkillRefs,
    createRawHumanismSkillRefs,
} from "./skills.js";

const installedSkills = {
    "narrative-monument": (environment: ProductionEnvironment) =>
        createNarrativeMonumentSkillRefs({
            path: environment.PI_NARRATIVE_MONUMENT_SKILL_DIRECTORY,
        }),
    "pale-watercolor": (environment: ProductionEnvironment) =>
        createPaleWatercolorSkillRefs({
            path: environment.PI_PALE_WATERCOLOR_SKILL_DIRECTORY,
        }),
    "raw-humanism": (environment: ProductionEnvironment) =>
        createRawHumanismSkillRefs({
            path: environment.PI_RAW_HUMANISM_SKILL_DIRECTORY,
        }),
} satisfies Record<NewsImageStyle, ProductionProcess["installedSkills"]>;

function newsImageProduction(style: NewsImageStyle): ProductionProcess {
    return defineProductionProcess({
        id: `news-image-${style}`,
        installedSkills: installedSkills[style],
        build: ({ environment, pi, skills, positiveInteger }) =>
            createNewsImageRegistration(style, {
                agent: new PiNewsImageAgent({ style, skills, ...pi }),
                capability: new HttpNewsImageRenderingCapability({
                    baseUrl: parseCrtBusinessApiBaseUrl(environment),
                    timeoutMs: positiveInteger(
                        "NEWS_IMAGE_API_TIMEOUT_MS",
                        180_000,
                    ),
                }),
            }),
    });
}

export const paleWatercolorProduction = newsImageProduction("pale-watercolor");
export const rawHumanismProduction = newsImageProduction("raw-humanism");
export const narrativeMonumentProduction =
    newsImageProduction("narrative-monument");
