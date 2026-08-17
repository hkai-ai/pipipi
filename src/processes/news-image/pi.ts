import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { OpenAIApiMode } from "../../agent-runtime/pi.js";
import type { SkillRef } from "../../agent-runtime/skills.js";
import { PiStructuredAgent } from "../../agent-runtime/structured.js";
import type {
    NewsImageAgent,
    NewsImageAgentRequest,
    NewsImageCompilation,
} from "./agent.js";

export type PiNewsImageAgentOptions = {
    skills: readonly SkillRef[];
    style: "narrative-monument" | "pale-watercolor" | "raw-humanism";
    cwd?: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    modelRuntime?: ModelRuntime;
};

/** Compiles one factual news brief with one fixed semantic style and no Tools. */
export class PiNewsImageAgent implements NewsImageAgent {
    readonly #agent: PiStructuredAgent;

    constructor(options: PiNewsImageAgentOptions) {
        const { style, ...runtime } = options;
        this.#agent = new PiStructuredAgent({
            ...runtime,
            instructions: [
                `You compile factual news into one style-${style} image prompt.`,
                "Follow the bound Runtime Skill. Do not generate an image, call a Tool, read a URL, or return Markdown.",
                "Return only the strict JSON object requested by the user message.",
            ],
        });
    }

    async compile(
        request: NewsImageAgentRequest,
    ): Promise<NewsImageCompilation> {
        const result = await this.#agent.run({
            prompt:
                `Compile this news title: ${JSON.stringify(request.title)}\n` +
                `News summary: ${JSON.stringify(request.summary)}\n` +
                "Return only JSON matching " +
                '{"newsIdentity":"one sentence","coreTension":"one sentence","realityAnchor":"one sentence","factExclusions":["one to five unsupported facts to avoid"],"sceneKernel":"one to three sentences","prompt":"the complete English prompt"}.',
            signal: request.signal,
        });
        if (!result.modelId) {
            throw new Error("The Pi model used for compilation is unknown");
        }
        return Object.freeze({
            output: result.output,
            promptModel: result.modelId,
        });
    }
}
