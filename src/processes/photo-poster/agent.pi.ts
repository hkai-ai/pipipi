/** 使用无 Tool Pi Agent 编译固定照片风格提示词。 */
import {
    PiStructuredAgent,
    type PiStructuredAgentOptions,
} from "../../agent-runtime/structured.js";

import type { PhotoPosterAgent } from "./agent.js";

/** 编译固定规则；原图只交给图片 Capability，文本 Agent 不猜测照片内容。 */
export class PiPhotoPosterAgent implements PhotoPosterAgent {
    readonly #agent: PiStructuredAgent;
    constructor(options: Omit<PiStructuredAgentOptions, "instructions">) {
        this.#agent = new PiStructuredAgent({
            ...options,
            instructions: [
                '按绑定的 Runtime Skill 编译英文图片编辑指令，仅返回 JSON {"prompt":"..."}。',
                "你看不到参考图。必须让图片模型从唯一参考图中分析主体；服务端未指定配色时才从参考图分析颜色。不得编造人物、地点、文字或视觉事实。",
                "服务端已解析的设计约束优先于 Skill 的默认搭配建议，其余核心视觉约束保留；不使用 Tool，不生成图片、不读取其他文件。",
            ],
        });
    }
    async compile(
        request: Parameters<PhotoPosterAgent["compile"]>[0],
    ): Promise<unknown> {
        return (
            await this.#agent.run({
                prompt: [
                    "编译绑定的照片海报风格。英文 prompt 长度 400–12000 字符。最终文字和固定画幅由服务端追加。",
                    ...(request.design
                        ? [
                              "以下为服务端已解析的设计约束。直接按这些约束编译，替换 Skill 中冲突的配色、文字颜色和构图建议，不保留备选配方，不再要求图片模型自行选色。",
                              request.design,
                          ]
                        : []),
                ].join("\n"),
                signal: request.signal,
            })
        ).output;
    }
}
