/** 复用图片网关配置与文件表单 Adapter，固定模板成图模型并净化提交失败。 */
import { resolveModelGateway } from "../model-gateway.js";
import {
    type EditImageRequest,
    type GeneratedImage,
    OpenAIImageGenerationClient,
    OpenAIImageGenerationError,
} from "./openai-image-generation.js";
import { TemplateImageSubmissionError } from "./template-image-fal.js";

export type TemplateImageEditor = {
    edit(request: EditImageRequest): Promise<GeneratedImage>;
};

export function createTemplateImageEditor(
    environment: Readonly<Record<string, string | undefined>>,
    options: { timeoutMs?: number; fetch?: typeof globalThis.fetch } = {},
): TemplateImageEditor {
    const gateway = resolveModelGateway(environment, "image");
    if (!gateway.apiKey) throw new Error("模板成图需要配置图片网关凭证");
    const client = new OpenAIImageGenerationClient({
        ...gateway,
        apiKey: gateway.apiKey,
        ...options,
    });
    return {
        async edit(request) {
            try {
                return await client.edit(
                    {
                        ...request,
                        model: "gpt-image-2.5-flare",
                        quality: "low",
                        outputFormat: "png",
                    },
                    // 启用既有 Adapter 的单次派发与幂等头，不自动重发。
                    () => {},
                );
            } catch (error) {
                const status =
                    error instanceof OpenAIImageGenerationError
                        ? error.status
                        : undefined;
                throw new TemplateImageSubmissionError(
                    status !== undefined &&
                        status >= 400 &&
                        status < 500 &&
                        ![408, 409, 425, 429].includes(status)
                        ? "provider_rejected"
                        : "submission_unknown",
                    status,
                );
            }
        },
    };
}
