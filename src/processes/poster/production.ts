/** minimal-zine-poster/v1 的生产装配：Pi Agent 编译 Prompt，HTTP Capability 调用 POST /posters */
import { parseBusinessApiBaseUrl } from "../content/config.js";
import { defineProductionProcess } from "../production.js";
import { PiPosterAgent } from "./agent.pi.js";
import { HttpPosterRenderingCapability } from "./capability.http.js";
import { createPosterRegistration } from "./registration.js";
import { createPosterSkillRefs } from "./skills.js";

export const posterProduction = defineProductionProcess({
    id: "minimal-zine-poster",
    installedSkills: (environment) =>
        createPosterSkillRefs({ path: environment.PI_POSTER_SKILL_DIRECTORY }),
    build: ({ environment, pi, skills, positiveInteger }) =>
        createPosterRegistration({
            agent: new PiPosterAgent({ skills, ...pi }),
            capability: new HttpPosterRenderingCapability({
                baseUrl: parseBusinessApiBaseUrl(
                    environment.BUSINESS_API_BASE_URL,
                ),
                timeoutMs: positiveInteger("POSTER_API_TIMEOUT_MS", 90_000),
            }),
        }),
});
