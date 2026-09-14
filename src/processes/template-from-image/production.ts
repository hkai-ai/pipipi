/** 在生产目录绑定模板 Skill、服务端模型覆盖及不含业务正文的诊断日志。 */
import pino from "pino";
import { defineProductionProcess } from "../production.js";
import { PiTemplateAgent } from "./agent.pi.js";
import { createTemplateRegistration } from "./registration.js";
import { createTemplateSkillRefs } from "./skills.js";

const logger = pino({ name: "template-diagnostics" });

export const templateProduction = defineProductionProcess({
    id: "template-from-image",
    environment: ["TEMPLATE_MODEL"],
    installedSkills: () => createTemplateSkillRefs(),
    build: ({ pi, skills, environment }) =>
        createTemplateRegistration({
            onDiagnostic: (record) => logger.warn(record, record.event),
            agent: new PiTemplateAgent({
                ...pi,
                skills,
                model: environment.TEMPLATE_MODEL?.trim() || pi.model,
            }),
        }),
});
