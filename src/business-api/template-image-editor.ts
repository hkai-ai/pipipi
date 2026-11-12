/** 复用图片网关配置与文件表单 Adapter，固定模板成图模型并净化提交失败。 */

import { resolveModelGateway } from "../model-gateway.js";
import type { ImageBackground } from "../processes/image-background.js";
import {
    OpenAIImageGenerationClient,
    OpenAIImageGenerationError,
} from "./openai-image-generation.js";
import { TemplateImageSubmissionError } from "./template-image-submission.js";

export type TemplateImageEditor = {
    edit(request: {
        image: {
            bytes: Buffer;
            mimeType: "image/png" | "image/jpeg" | "image/webp";
        };
        prompt: string;
        size: string;
        background?: ImageBackground;
        idempotencyKey: string;
        signal: AbortSignal;
    }): Promise<Buffer>;
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
        async edit({
            image,
            prompt,
            size,
            background,
            idempotencyKey,
            signal,
        }) {
            try {
                const result = await client.edit(
                    {
                        image,
                        prompt,
                        size,
                        background,
                        idempotencyKey,
                        signal,
                        model: "gpt-image-2.5-flare",
                        quality: "low",
                        outputFormat: "png",
                    },
                    { singleDispatch: true },
                );
                return result.bytes;
            } catch (error) {
                const status =
                    error instanceof OpenAIImageGenerationError
                        ? error.status
                        : undefined;
                throw TemplateImageSubmissionError.fromStatus(status);
            }
        },
    };
}
