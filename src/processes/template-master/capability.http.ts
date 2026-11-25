/** 调用内部 Business API 完成母版改图与上传，费用经账本头并入本次运行。 */
import { fetchBilled } from "../../process-runtime/cost.js";
import {
    MasterCapabilityError,
    type MasterEditRequest,
    masterEditResponseSchema,
    type TemplateMasterCapability,
} from "./capability.js";
import { preparedImageSchema } from "./contract.js";
import { EDIT_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from "./thresholds.js";

export class HttpTemplateMasterCapability implements TemplateMasterCapability {
    constructor(private readonly baseUrl: string) {}

    async edit(request: MasterEditRequest): Promise<Buffer> {
        const body = await this.call(
            "edit",
            {
                image: request.image.toString("base64"),
                prompt: request.prompt,
                size: request.size,
                ...(request.model ? { model: request.model } : {}),
                ...(request.quality ? { quality: request.quality } : {}),
                ...(request.background
                    ? { background: request.background }
                    : {}),
                idempotencyKey: request.idempotencyKey,
            },
            request.signal,
            EDIT_TIMEOUT_MS,
            "unknown",
        );
        const parsed = masterEditResponseSchema.safeParse(body);
        if (!parsed.success) throw new MasterCapabilityError("unknown");
        return Buffer.from(parsed.data.image, "base64");
    }

    async upload(image: Buffer, signal: AbortSignal) {
        const body = await this.call(
            "upload",
            { image: image.toString("base64") },
            signal,
            UPLOAD_TIMEOUT_MS,
            "upload",
        );
        const parsed = preparedImageSchema.safeParse(body);
        if (!parsed.success) throw new MasterCapabilityError("upload");
        return parsed.data;
    }

    private async call(
        path: string,
        input: unknown,
        signal: AbortSignal,
        timeoutMs: number,
        fallback: "unknown" | "upload",
    ): Promise<unknown> {
        try {
            const response = await fetchBilled(
                fetch,
                new URL(`/template-master/${path}`, this.baseUrl),
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(input),
                    signal: AbortSignal.any([
                        signal,
                        AbortSignal.timeout(timeoutMs),
                    ]),
                },
            );
            if (!response.ok) {
                const payload = (await response.json().catch(() => ({}))) as {
                    error?: { reason?: unknown };
                };
                throw MasterCapabilityError.fromResponse(
                    payload.error?.reason,
                    fallback,
                );
            }
            return await response.json();
        } catch (error) {
            if (error instanceof MasterCapabilityError) throw error;
            signal.throwIfAborted();
            throw new MasterCapabilityError(fallback);
        }
    }
}
