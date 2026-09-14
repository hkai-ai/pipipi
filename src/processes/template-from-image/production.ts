/** 在显式生产目录中绑定模板编译 Skill，并解析模板专属的服务端模型覆盖。 */
import { defineProductionProcess } from "../production.js";
import { PiTemplateAgent } from "./agent.pi.js";
import { createTemplateRegistration } from "./registration.js";
import { createTemplateSkillRefs } from "./skills.js";

export const templateProduction = defineProductionProcess({
    id: "template-from-image",
    environment: ["TEMPLATE_MODEL"],
    installedSkills: () => createTemplateSkillRefs(),
    build: ({ pi, skills, environment }) =>
        createTemplateRegistration({
            agent: new PiTemplateAgent({
                ...pi,
                skills,
                model: environment.TEMPLATE_MODEL?.trim() || pi.model,
            }),
        }),
});
