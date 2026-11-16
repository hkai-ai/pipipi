/** 母版改图与上传的内部服务：单次派发改图并校验 PNG 尺寸，内容寻址上传到模板公读存储。 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { preparedTemplateImageSchema } from "../processes/template-from-source/capability.js";
import {
    masterEditRequestSchema,
    masterUploadRequestSchema,
} from "../processes/template-master/capability.js";
import type { ObjectStorageCapability } from "./object-storage.js";
import type { TemplateImageEditor } from "./template-image-editor.js";
import { TemplateImageSubmissionError } from "./template-image-submission.js";

export class TemplateMasterError extends Error {
    constructor(readonly reason: "rejected" | "unknown" | "upload") {
        super("母版服务未完成");
    }
}

const sha256 = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");

export class TemplateMasterService {
    constructor(
        private readonly options: {
            editor?: TemplateImageEditor;
            storage?: ObjectStorageCapability;
        },
    ) {}

    async execute(operation: string, input: unknown, signal: AbortSignal) {
        if (operation === "edit") return this.edit(input, signal);
        if (operation === "upload") return this.upload(input, signal);
        throw new Error("未知母版操作");
    }

    private async edit(value: unknown, signal: AbortSignal) {
        const input = masterEditRequestSchema.parse(value);
        const editor = this.options.editor;
        if (!editor) throw new TemplateMasterError("unknown");
        let bytes: Buffer;
        try {
            bytes = await editor.edit({
                image: {
                    bytes: Buffer.from(input.image, "base64"),
                    mimeType: "image/png",
                },
                prompt: input.prompt,
                size: input.size,
                idempotencyKey: input.idempotencyKey,
                signal,
            });
        } catch (error) {
            throw new TemplateMasterError(
                error instanceof TemplateImageSubmissionError &&
                    error.type === "provider_rejected"
                    ? "rejected"
                    : "unknown",
            );
        }
        const meta = await sharp(bytes, { limitInputPixels: 40_000_000 })
            .metadata()
            .catch(() => undefined);
        const [width, height] = input.size.split("x").map(Number);
        if (
            bytes.length > 20_000_000 ||
            meta?.format !== "png" ||
            (meta.pages ?? 1) !== 1 ||
            meta.width !== width ||
            meta.height !== height
        )
            throw new TemplateMasterError("unknown");
        return { image: bytes.toString("base64") };
    }

    private async upload(value: unknown, signal: AbortSignal) {
        const input = masterUploadRequestSchema.parse(value);
        const storage = this.options.storage;
        if (!storage) throw new TemplateMasterError("upload");
        const bytes = Buffer.from(input.image, "base64");
        const meta = await sharp(bytes, { limitInputPixels: 40_000_000 })
            .metadata()
            .catch(() => undefined);
        if (bytes.length > 20_000_000 || meta?.format !== "png")
            throw new TemplateMasterError("upload");
        const digest = sha256(bytes);
        const key = `gallery/template-images/${digest}.png`;
        try {
            const stored = await storage.upload(
                {
                    objectKey: key,
                    bytes,
                    contentType: "image/png",
                    immutableSha256: digest,
                    cacheControl: "public, max-age=31536000, immutable",
                },
                { signal },
            );
            if (
                stored.urlAccess !== "public" ||
                stored.url !== `https://assets.memebuy.cn/${key}`
            )
                throw new Error("地址不符");
            return preparedTemplateImageSchema.parse({
                url: stored.url,
                sha256: digest,
                width: meta.width,
                height: meta.height,
                contentType: "image/png",
            });
        } catch {
            throw new TemplateMasterError("upload");
        }
    }
}
