/** 商品做同款改图与上传内部服务：转发多图编辑、校验 PNG 产物并上传至受控对象存储。 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
    remixEditRequestSchema,
    remixEditResponseSchema,
    remixUploadedImageSchema,
    remixUploadRequestSchema,
} from "../processes/product-remix/capability.js";
import { isProductRemixImageUrl } from "../processes/product-remix/contract.js";
import type { ObjectStorageCapability } from "./object-storage.js";
import {
    type TemplateImageEditor,
    templateImageEditorModel,
} from "./template-image-editor.js";
import { TemplateImageSubmissionError } from "./template-image-submission.js";

export class ProductRemixServiceError extends Error {
    constructor(readonly reason: "rejected" | "unknown" | "upload") {
        super("商品做同款服务未完成");
        this.name = "ProductRemixServiceError";
    }
}

const sha256 = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");

const extensionMap = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
} as const;

export class ProductRemixService {
    constructor(
        private readonly options: {
            editor?: TemplateImageEditor;
            storage?: ObjectStorageCapability;
        },
    ) {}

    async execute(operation: string, input: unknown, signal: AbortSignal) {
        if (operation === "edit") return this.edit(input, signal);
        if (operation === "upload") return this.upload(input, signal);
        throw new Error("未知做同款操作");
    }

    private async edit(value: unknown, signal: AbortSignal) {
        const input = remixEditRequestSchema.parse(value);
        const editor = this.options.editor;
        if (!editor) throw new ProductRemixServiceError("unknown");

        let bytes: Buffer;
        try {
            bytes = await editor.edit({
                images: input.images.map((item, index) => ({
                    bytes: Buffer.from(item.data, "base64"),
                    mimeType: item.mimeType,
                    filename: `remix-${index + 1}.${extensionMap[item.mimeType]}`,
                })),
                prompt: input.prompt,
                size: input.size,
                idempotencyKey: input.idempotencyKey,
                signal,
            });
        } catch (error) {
            throw new ProductRemixServiceError(
                error instanceof TemplateImageSubmissionError &&
                    error.type === "provider_rejected"
                    ? "rejected"
                    : "unknown",
            );
        }

        const meta = await sharp(bytes, { limitInputPixels: 40_000_000 })
            .metadata()
            .catch(() => undefined);
        if (
            bytes.length > 20_000_000 ||
            meta?.format !== "png" ||
            (meta.pages ?? 1) !== 1 ||
            !meta.width ||
            !meta.height ||
            meta.width < 64 ||
            meta.height < 64 ||
            meta.width > 4_096 ||
            meta.height > 4_096
        ) {
            throw new ProductRemixServiceError("unknown");
        }

        return remixEditResponseSchema.parse({
            image: bytes.toString("base64"),
            width: meta.width,
            height: meta.height,
            modelName: editor.modelName?.trim() || templateImageEditorModel,
        });
    }

    private async upload(value: unknown, signal: AbortSignal) {
        const input = remixUploadRequestSchema.parse(value);
        const storage = this.options.storage;
        if (!storage) throw new ProductRemixServiceError("upload");

        const bytes = Buffer.from(input.image, "base64");
        const meta = await sharp(bytes, { limitInputPixels: 40_000_000 })
            .metadata()
            .catch(() => undefined);
        if (
            bytes.length > 20_000_000 ||
            meta?.format !== "png" ||
            (meta.pages ?? 1) !== 1 ||
            !meta.width ||
            !meta.height ||
            meta.width < 64 ||
            meta.height < 64 ||
            meta.width > 4_096 ||
            meta.height > 4_096
        ) {
            throw new ProductRemixServiceError("upload");
        }

        const digest = sha256(bytes);
        const key = `product-remix/${digest}.png`;
        try {
            const stored = await storage.upload(
                {
                    objectKey: key,
                    bytes,
                    contentType: "image/png",
                    immutableSha256: digest,
                    cacheControl: "private, max-age=31536000, immutable",
                },
                { signal },
            );
            if (!isProductRemixImageUrl(stored.url)) {
                throw new Error("产物地址不符合安全契约");
            }
            return remixUploadedImageSchema.parse({
                url: stored.url,
                width: meta.width,
                height: meta.height,
            });
        } catch {
            throw new ProductRemixServiceError("upload");
        }
    }
}
