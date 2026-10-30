/** 装配三个固定图片生产阶段，绑定原业务规则、内部持久化和既有编译成员。 */
import pino from "pino";
import { parseCrtBusinessApiBaseUrl } from "../crt/production.js";
import {
    defineProductionProcess,
    type ProductionContext,
} from "../production.js";
import { PiTemplateStrategyAgent } from "./agent.pi.js";
import { HttpTemplateImagePreparation } from "./capability.http.js";
import {
    createTemplatePlanRegistration,
    createTemplateRenderRegistration,
    createTemplateSourceRegistration,
} from "./registration.js";

const preparation = ({ environment }: ProductionContext) =>
    new HttpTemplateImagePreparation(parseCrtBusinessApiBaseUrl(environment));
const logger = pino({ name: "template-strategy-diagnostics" });
const environment = [
    "CRT_BUSINESS_API_BASE_URL",
    "BUSINESS_API_BASE_URL",
] as const;
export const templatePlanProduction = defineProductionProcess({
    id: "template-image-plan",
    environment: [...environment, "TEMPLATE_MODEL"],
    installedSkills: () => [
        {
            name: "template-image-preparer",
            version: "v3",
            sha256: "916f547308b56d4487728b4e12d693e0ae3acbc33bd2b145a7169bbfbba125ba",
            path: ".pi/skills/template-image-preparer",
        },
    ],
    build: (context) =>
        createTemplatePlanRegistration({
            onDiagnostic: (record) => logger.warn(record, record.event),
            preparation: preparation(context),
            agent: new PiTemplateStrategyAgent({
                ...context.pi,
                skills: context.skills,
                model:
                    context.environment.TEMPLATE_MODEL?.trim() ||
                    (context.pi.provider === "openai"
                        ? "gpt-5.4"
                        : context.pi.model),
            }),
        }),
});
export const templateRenderProduction = defineProductionProcess({
    id: "template-image-render",
    environment,
    build: (context) => createTemplateRenderRegistration(preparation(context)),
});
export const templateSourceProduction = defineProductionProcess({
    id: "template-from-source",
    environment,
    members: [{ id: "template-from-image", version: "v1" }],
    build: (context) => {
        const compiler = context.members.registry.find({
            id: "template-from-image",
            version: "v1",
        });
        if (!compiler) throw new Error("缺少固定模板编译成员");
        return createTemplateSourceRegistration({
            compiler,
            attemptRunner: context.members.attemptRunner,
            preparation: preparation(context),
        });
    },
});
