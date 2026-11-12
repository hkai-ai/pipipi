/** 复用图片网关配置与文件表单 Adapter，固定模板成图模型并净化提交失败。 */

import { resolveModelGateway } from "../model-gateway.js";
import type { ImageBackground } from "../processes/image-background.js";
import {
    OpenAIImageGenerationClient,
    OpenAIImageGenerationError,
} from "./openai-image-generation.js";
import {
    type GatewayReceipt,
    receiptSchema,
} from "./template-gateway-receipt.js";
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
        onReceipt?: (receipt: GatewayReceipt) => void;
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
            onReceipt,
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
                onReceipt?.(
                    receiptSchema.parse({
                        reason: "delivered",
                        httpStatus: result.httpStatus,
                        requestId: result.requestId,
                    }),
                );
                return result.bytes;
            } catch (error) {
                const status =
                    error instanceof OpenAIImageGenerationError
                        ? error.status
                        : undefined;
                const errorCause =
                    error instanceof Error ? error.cause : undefined;
                const name =
                    errorCause instanceof Error ? errorCause.name : undefined;
                const receipt = receiptSchema.parse({
                    reason:
                        status !== undefined
                            ? status < 300
                                ? "invalid_response"
                                : "http_error"
                            : name === "TimeoutError"
                              ? "timeout"
                              : name === "AbortError" || signal.aborted
                                ? "cancelled"
                                : errorCause
                                  ? "connection"
                                  : "unknown",
                    httpStatus: status,
                    requestId:
                        error instanceof OpenAIImageGenerationError
                            ? error.requestId
                            : undefined,
                    errorCode:
                        error instanceof OpenAIImageGenerationError
                            ? error.code
                            : undefined,
                });
                onReceipt?.(receipt);
                throw TemplateImageSubmissionError.fromStatus(status);
            }
        },
    };
}
