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

export const characterEmojiProduction = defineProductionProcess({
    id: "character-emoji",
    environment: [
        "CRT_BUSINESS_API_BASE_URL",
        "BUSINESS_API_BASE_URL",
        "PHOTO_POSTER_API_TIMEOUT_MS",
        "CHARACTER_EMOJI_API_KEY",
        "CHARACTER_EMOJI_BASE_URL",
        "CHARACTER_EMOJI_PLANNER_BASE_URL",
        "CHARACTER_EMOJI_PLANNER_API_KEY",
    ],
    installedSkills: () => createCharacterEmojiSkillRefs(),
    build: ({ environment, skills, positiveInteger }) => {
        const config = {
            apiKey: environment.CHARACTER_EMOJI_API_KEY ?? "",
            baseUrl:
                environment.CHARACTER_EMOJI_BASE_URL?.trim() ||
                "https://llmapi.memene.cn/openai/v1",
        };
        return createCharacterEmojiRegistration({
            version: "v2",
            onDiagnostic: (record) => logger.warn(record, record.event),
            onObservation: (record) => logger.info(record, record.event),
            agent: new PiCharacterEmojiAgent({
                apiKey:
                    environment.CHARACTER_EMOJI_PLANNER_API_KEY?.trim() ||
                    config.apiKey,
                baseUrl:
                    environment.CHARACTER_EMOJI_PLANNER_BASE_URL?.trim() ||
                    config.baseUrl,
                skills,
                search: new ResponsesMemeSearch(config),
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
