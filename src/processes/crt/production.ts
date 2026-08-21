/** crt-interface-image/v1 的生产装配：Pi Agent 编译 Prompt，HTTP Capability 调用 CRT Business API 的 POST /crt-images */
import { parseBusinessApiBaseUrl } from "../content/config.js";
import {
    defineProductionProcess,
    type ProductionEnvironment,
} from "../production.js";
import { PiCrtAgent } from "./agent.pi.js";
import { HttpCrtRenderingCapability } from "./capability.http.js";
import { createCrtRegistration } from "./registration.js";
import { createCrtSkillRefs } from "./skills.js";

export const crtProduction = defineProductionProcess({
    id: "crt-interface-image",
    environment: [
        "PI_CRT_SKILL_DIRECTORY",
        "CRT_BUSINESS_API_BASE_URL",
        "BUSINESS_API_BASE_URL",
        "CRT_API_TIMEOUT_MS",
    ],
    installedSkills: (environment) =>
        createCrtSkillRefs({ path: environment.PI_CRT_SKILL_DIRECTORY }),
    build: ({ environment, pi, skills, positiveInteger }) =>
        createCrtRegistration({
            agent: new PiCrtAgent({ skills, ...pi }),
            capability: new HttpCrtRenderingCapability({
                baseUrl: parseCrtBusinessApiBaseUrl(environment),
                timeoutMs: positiveInteger("CRT_API_TIMEOUT_MS", 180_000),
            }),
        }),
});

/** The image Business API, which production Compose separates from the text one. */
export function parseCrtBusinessApiBaseUrl(
    environment: ProductionEnvironment,
): string {
    return parseBusinessApiBaseUrl(
        environment.CRT_BUSINESS_API_BASE_URL ??
            environment.BUSINESS_API_BASE_URL,
    );
}
