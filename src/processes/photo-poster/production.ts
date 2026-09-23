/** 照片海报 Process 的生产装配，绑定固定 Skill 与受控图片能力。 */
import { parseCrtBusinessApiBaseUrl } from "../crt/production.js";
import {
    defineProductionProcess,
    type ProductionProcess,
} from "../production.js";
import { PiPhotoPosterAgent } from "./agent.pi.js";
import { HttpPhotoPosterRenderingCapability } from "./capability.http.js";
import { createPhotoPosterRegistration } from "./registration.js";
import { createPhotoPosterSkillRefs } from "./skills.js";
import { type PhotoPosterStyle, photoPosterProcessId } from "./style.js";

function photoPosterProduction(style: PhotoPosterStyle): ProductionProcess {
    return defineProductionProcess({
        id: photoPosterProcessId(style),
        environment: [
            "CRT_BUSINESS_API_BASE_URL",
            "BUSINESS_API_BASE_URL",
            "PHOTO_POSTER_API_TIMEOUT_MS",
        ],
        installedSkills: () => createPhotoPosterSkillRefs(style),
        build: ({ environment, pi, skills, positiveInteger }) =>
            createPhotoPosterRegistration(style, {
                agent: new PiPhotoPosterAgent({ skills, ...pi }),
                capability: new HttpPhotoPosterRenderingCapability({
                    baseUrl: parseCrtBusinessApiBaseUrl(environment),
                    timeoutMs: positiveInteger(
                        "PHOTO_POSTER_API_TIMEOUT_MS",
                        180_000,
                    ),
                }),
            }),
    });
}
export const dopamineProduction = photoPosterProduction("dopamine");
export const monoColorProduction = photoPosterProduction("mono-color");
export const travelAbstractionProduction =
    photoPosterProduction("travel-abstraction");
export const crayonProduction = photoPosterProduction("crayon");
export const monochromeProduction = photoPosterProduction("monochrome");
export const woodcutProduction = photoPosterProduction("woodcut");
export const photoDoodleCollageProduction = photoPosterProduction(
    "photo-doodle-collage",
);
