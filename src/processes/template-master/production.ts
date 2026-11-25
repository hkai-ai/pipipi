/** 在生产目录绑定母版 v1（兼容旧版）与 v2（显式单次修图）的依赖与内部改图上传服务。 */
import { parseCrtBusinessApiBaseUrl } from "../crt/production.js";
import { defineProductionProcess } from "../production.js";
import { HttpTemplateMasterCapability } from "./capability.http.js";
import { createTemplateMasterRegistration } from "./registration.js";
import { createTemplateMasterSkillRefs } from "./skills.js";
import { createTemplateMasterV2Registration } from "./v2.js";
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
                model: environment.TEMPLATE_MODEL?.trim() || pi.model,
            }),
        }),
});

export const templateMasterV2Production = defineProductionProcess({
    id: "template-master",
    environment: ["CRT_BUSINESS_API_BASE_URL"],
    build: ({ environment }) =>
        createTemplateMasterV2Registration({
            capability: new HttpTemplateMasterCapability(
                parseCrtBusinessApiBaseUrl(environment),
            ),
        }),
});
