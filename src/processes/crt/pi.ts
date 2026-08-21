/** CRT 的 Pi Adapter */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { OpenAIApiMode } from "../../agent-runtime/pi.js";
import type { SkillRef } from "../../agent-runtime/skills.js";
import { PiStructuredAgent } from "../../agent-runtime/structured.js";
import type { CrtAgent, CrtAgentRequest } from "./agent.js";

export type PiCrtAgentOptions = {
    skills: readonly SkillRef[];
    cwd?: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    modelRuntime?: ModelRuntime;
};

/** Compiles one reference-image transformation prompt with no image or Tools. */
export class PiCrtAgent implements CrtAgent {
    readonly #agent: PiStructuredAgent;

    constructor(options: PiCrtAgentOptions) {
        this.#agent = new PiStructuredAgent({
            ...options,
            instructions: [
                "You compile one uploaded-image transformation into a TaiT CRT interface prompt.",
                "Follow the bound Runtime Skill. You cannot see the source image; direct the downstream image editor to inspect it.",
                "Do not generate an image, call a Tool, or return Markdown.",
                "Return only the strict JSON object requested by the user message.",
            ],
        });
    }

    async compile(request: CrtAgentRequest): Promise<unknown> {
        const result = await this.#agent.run({
            prompt:
                `Compile one source-image transformation with palette ${JSON.stringify(request.palette)} and aspect ratio ${JSON.stringify(request.aspectRatio)}. ` +
                "Return one valid JSON object on a single logical line. JSON-escape every quote and encode each paragraph separator inside prompt as \\n\\n; prompt must decode to exactly four paragraphs. " +
                'Use the exact phrases "attached source image", "20%-30% connected open field", and "avoid" in prompt so the host can verify the visual contract. ' +
                "Return only JSON matching " +
                '{"prompt":"exactly four paragraphs separated by blank lines","recipe":{"wallpaperPlacement":"allowed value","crop":"allowed value","subjectCoverage":70,"windowCount":4,"windowConstellation":"allowed value","sizeHierarchy":"allowed value","dominantApplication":"allowed value","extractionCount":2,"extractionGeometry":"allowed value","cartoonTreatment":"allowed value","caricatureMutation":"allowed value","midtoneMap":"allowed value","polarity":"allowed value","signalEmphasis":"allowed value"}}.',
            signal: request.signal,
        });
        return result.output;
    }
}
