/** 在生产目录绑定商品做同款流程的固定 Skill、多模态规划质检模型与内部改图上传服务。 */
import { parseCrtBusinessApiBaseUrl } from "../crt/production.js";
import { defineProductionProcess } from "../production.js";
import { PiProductRemixAgent } from "./agent.pi.js";
import { HttpProductRemixCapability } from "./capability.http.js";
import { createProductRemixRegistration } from "./registration.js";
import { createProductRemixSkillRefs } from "./skills.js";

export const productRemixProduction = defineProductionProcess({
    id: "product-remix",
    environment: ["CRT_BUSINESS_API_BASE_URL", "TEMPLATE_MODEL"],
    installedSkills: () => createProductRemixSkillRefs(),
    build: ({ environment, pi, skills }) =>
        createProductRemixRegistration({
            capability: new HttpProductRemixCapability(
                parseCrtBusinessApiBaseUrl(environment),
            ),
            agent: new PiProductRemixAgent({
                ...pi,
                skills,
                model:
                    environment.TEMPLATE_MODEL?.trim() ||
                    (pi.provider === "openai" ? "gpt-5.4" : pi.model),
            }),
        }),
});
