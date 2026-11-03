/** 装配固定 Skill、专用 Pi Agent、DeepSeek 搜梗与多图渲染 Capability。 */
import pino from "pino";
import { parseCrtBusinessApiBaseUrl } from "../crt/production.js";
import { defineProductionProcess } from "../production.js";
import { PiCharacterEmojiAgent } from "./agent.pi.js";
import { HttpCharacterEmojiRenderingCapability } from "./capability.http.js";
import { createCharacterEmojiRegistration } from "./registration.js";
import { ResponsesMemeSearch } from "./search.responses.js";
import { createCharacterEmojiSkillRefs } from "./skills.js";

export { characterEmojiModel } from "./model.js";

const logger = pino({ name: "character-emoji-diagnostics" });

function production(version: "v2" | "v3") {
    return defineProductionProcess({
        id: "character-emoji",
        environment: [
            "CRT_BUSINESS_API_BASE_URL",
            "PHOTO_POSTER_API_TIMEOUT_MS",
        ],
        installedSkills: () => createCharacterEmojiSkillRefs(),
        build: ({ environment, pi, skills, positiveInteger }) => {
            const gateway = pi.gateway ?? {};
            return createCharacterEmojiRegistration({
                version,
                onDiagnostic: (record) => logger.warn(record, record.event),
                onObservation: (record) => logger.info(record, record.event),
                agent: new PiCharacterEmojiAgent({
                    version,
                    gateway,
                    skills,
                    search: new ResponsesMemeSearch({ gateway }),
                }),
                capability: new HttpCharacterEmojiRenderingCapability({
                    baseUrl: parseCrtBusinessApiBaseUrl(environment),
                    timeoutMs: positiveInteger(
                        "PHOTO_POSTER_API_TIMEOUT_MS",
                        300_000,
                    ),
                }),
            });
        },
    });
}
export const characterEmojiProduction = production("v2");
export const characterEmojiV3Production = production("v3");
