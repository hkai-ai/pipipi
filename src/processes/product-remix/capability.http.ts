/** 调用内部 Business API 完成商品做同款改图与上传，并将费用账本头并入本次运行。 */
import { fetchBilled } from "../../process-runtime/cost.js";
import {
    type ProductRemixCapability,
    ProductRemixCapabilityError,
    type ProductRemixEditRequest,
    type ProductRemixEditResult,
    type ProductRemixUploadedImage,
    remixEditResponseSchema,
    remixUploadedImageSchema,
} from "./capability.js";

const EDIT_TIMEOUT_MS = 200_000;
const UPLOAD_TIMEOUT_MS = 60_000;

export class HttpProductRemixCapability implements ProductRemixCapability {
    constructor(private readonly baseUrl: string) {}

    async edit(
        request: ProductRemixEditRequest,
    ): Promise<ProductRemixEditResult> {
        const body = await this.call(
            "edit",
            {
                images: request.images.map((item) => ({
                    data: item.bytes.toString("base64"),
                    mimeType: item.mimeType,
                })),
                prompt: request.prompt,
                size: request.size,
                idempotencyKey: request.idempotencyKey,
            },
            request.signal,
            EDIT_TIMEOUT_MS,
            "unknown",
        );
        const parsed = remixEditResponseSchema.safeParse(body);
        if (!parsed.success) throw new ProductRemixCapabilityError("unknown");
        return {
            bytes: Buffer.from(parsed.data.image, "base64"),
            width: parsed.data.width,
            height: parsed.data.height,
            modelName: parsed.data.modelName,
        };
    }

    async upload(
        image: Buffer,
        signal: AbortSignal,
    ): Promise<ProductRemixUploadedImage> {
        const body = await this.call(
            "upload",
            { image: image.toString("base64") },
            signal,
            UPLOAD_TIMEOUT_MS,
            "upload",
        );
        const parsed = remixUploadedImageSchema.safeParse(body);
        if (!parsed.success) throw new ProductRemixCapabilityError("upload");
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
                new URL(`/product-remix/${path}`, this.baseUrl),
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
                throw ProductRemixCapabilityError.fromResponse(
                    payload.error?.reason,
                    fallback,
                );
            }
            return await response.json();
        } catch (error) {
            if (error instanceof ProductRemixCapabilityError) throw error;
            signal.throwIfAborted();
            throw new ProductRemixCapabilityError(fallback);
        }
    }
}
