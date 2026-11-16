/** 在生产目录绑定母版流程的固定 Skill、校验模型与内部改图上传服务。 */
import { parseCrtBusinessApiBaseUrl } from "../crt/production.js";
import { defineProductionProcess } from "../production.js";
import { HttpTemplateMasterCapability } from "./capability.http.js";
import { createTemplateMasterRegistration } from "./registration.js";
import { createTemplateMasterSkillRefs } from "./skills.js";
import { PiMasterVerifier } from "./verifier.js";

export const templateMasterProduction = defineProductionProcess({
    id: "template-master",
    environment: ["CRT_BUSINESS_API_BASE_URL", "TEMPLATE_MODEL"],
    installedSkills: () => createTemplateMasterSkillRefs(),
    build: ({ environment, pi, skills }) =>
        createTemplateMasterRegistration({
            capability: new HttpTemplateMasterCapability(
                parseCrtBusinessApiBaseUrl(environment),
            ),
            verifier: new PiMasterVerifier({
                ...pi,
                skills,
                model:
                    environment.TEMPLATE_MODEL?.trim() ||
                    (pi.provider === "openai" ? "gpt-5.4" : pi.model),
            }),
        }),
});
