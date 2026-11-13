/** 在生产目录以准确流程版本绑定印花拆解规则与既有模板模型配置。 */
import { defineProductionProcess } from "../../production.js";
import { PiPrintDesignAgent } from "./agent.js";
import { skillRef } from "./contract.js";
import { createPrintDesignRegistration } from "./registration.js";
export const printDesignProduction = defineProductionProcess({
    id: "template-from-image",
    environment: ["TEMPLATE_MODEL"],
    installedSkills: () => [skillRef],
    build: ({ pi, skills, environment }) =>
        createPrintDesignRegistration({
            agent: new PiPrintDesignAgent({
                ...pi,
                skills,
                model:
                    environment.TEMPLATE_MODEL?.trim() ||
                    (pi.provider === "openai" ? "gpt-5.4" : pi.model),
            }),
        }),
});
