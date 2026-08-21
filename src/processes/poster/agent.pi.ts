/** agent.ts 里 PosterAgent Port 的生产 Pi 实现：无 Tool 把 brief 编译成海报 Prompt */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { OpenAIApiMode } from "../../agent-runtime/pi.js";
import type { SkillRef } from "../../agent-runtime/skills.js";
import { PiStructuredAgent } from "../../agent-runtime/structured.js";
import type { PosterAgent, PosterAgentRequest } from "./agent.js";

export type PiPosterAgentOptions = {
    skills: readonly SkillRef[];
    cwd?: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    modelRuntime?: ModelRuntime;
};

/** Compiles one poster brief with the exact Runtime Skill and no Tools. */
export class PiPosterAgent implements PosterAgent {
    readonly #agent: PiStructuredAgent;

    constructor(options: PiPosterAgentOptions) {
        this.#agent = new PiStructuredAgent({
            ...options,
            instructions: [
                "You compile a business brief into a minimal-zine poster prompt.",
                "Follow the bound Runtime Skill. Do not generate an image, call a Tool, or return Markdown.",
                "Return only the strict JSON object requested by the user message.",
            ],
        });
    }

    async compile(request: PosterAgentRequest): Promise<unknown> {
        const textInstruction = request.text
            ? `Preserve this exact in-image text in the prompt: ${JSON.stringify(request.text)}. `
            : "Choose one short poetic in-image phrase as directed by the Skill. ";
        const result = await this.#agent.run({
            prompt:
                `Compile this poster brief: ${JSON.stringify(request.brief)}\n` +
                textInstruction +
                "Return only JSON matching " +
                '{"prompt":"exactly four paragraphs separated by blank lines","recipe":{"layout":"one allowed layout","anchor":"one allowed anchor","typography":"one allowed typography mode","accent":"one exact high-chroma hue and material form","texture":"one allowed texture mode","mood":"one allowed mood"},"interpretation":"one short sentence"}.',
            signal: request.signal,
        });
        return result.output;
    }
}
