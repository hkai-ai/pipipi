/** 持久保存策略与图片审批，先审策略后生图、先审成图后上传，未知提交禁止重投。 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { sourcePhotoSchema } from "../processes/photo-poster/capability.js";
import { decodeTemplateImage } from "../processes/template-from-image/image.js";
import {
    digestSchema,
    imageApprovalSchema,
    preparedTemplateImageSchema,
    productionIdSchema,
    renderInputSchema,
    TemplateImagePreparationError,
} from "../processes/template-from-source/capability.js";
import {
    compileReplacementPrompt,
    parseReplacementStrategy,
    replacementStrategySchema,
} from "../processes/template-from-source/strategy.js";
import { assertImageBackground } from "./image-background.js";
import type { ObjectStorageCapability } from "./object-storage.js";
import { downloadSourcePhoto } from "./source-photo.js";
import type { TemplateImageEditor } from "./template-image-editor.js";
import {
    assertFalTemplateBackground,
    type TemplateImageRenderer,
    TemplateImageResultError,
    TemplateImageSubmissionError,
} from "./template-image-fal.js";

const hash = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
const planSchema = z.strictObject({
    productionId: productionIdSchema,
    sourceImageUrl: sourcePhotoSchema,
    analyzedImageSha256: digestSchema,
    strategy: replacementStrategySchema,
    note: z.string().max(500).nullable(),
});
type Plan = z.infer<typeof planSchema> & {
    sourceImageSha256: string;
    strategySha256: string;
    sourceMime: string;
    execution?: { version: "v2"; prompt: string; promptSha256: string };
};
type Attempt = {
    provider?: "fal" | "openai";
    state:
        | "provider_rejected"
        | "approved"
        | "submission_unknown"
        | "provider_pending"
        | "provider_complete"
        | "image_ready";
    approval: z.infer<typeof renderInputSchema> & { decidedAt: string };
    requestId?: string;
    failure?: {
        type: "provider_rejected" | "submission_unknown";
        httpStatus?: number;
    };
};
export class TemplateImageProduction {
    constructor(
        private readonly options: {
            directory: string;
            renderer?: TemplateImageRenderer;
            editor?: TemplateImageEditor;
            storage?: ObjectStorageCapability;
            loadSource?: typeof downloadSourcePhoto;
        },
    ) {}
    async execute(
        operation: string,
        input: unknown,
        signal: AbortSignal,
    ): Promise<unknown> {
        if (operation === "plans") return this.plan(input, signal);
        if (operation === "render")
            return this.render(renderInputSchema.parse(input), signal);
        if (operation === "finalize")
            return this.finalize(imageApprovalSchema.parse(input), signal);
        throw new Error("未知图片生产操作");
    }
    private path(id: string, name: string) {
        return join(this.options.directory, productionIdSchema.parse(id), name);
    }
    private async read<T>(id: string, name: string): Promise<T> {
        return JSON.parse(await readFile(this.path(id, name), "utf8")) as T;
    }
    private async save(id: string, name: string, value: unknown) {
        const file = this.path(id, name);
        const temporary = `${file}.tmp`;
        await writeFile(temporary, JSON.stringify(value), {
            mode: 0o600,
            flush: true,
        });
        await rename(temporary, file);
    }
    private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
        const lock = this.path(id, "operation.lock");
        await writeFile(lock, "", { flag: "wx", mode: 0o600 });
        try {
            return await action();
        } finally {
            await unlink(lock);
        }
    }
    private async optional<T>(
        id: string,
        name: string,
    ): Promise<T | undefined> {
        try {
            return await this.read<T>(id, name);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    private async plan(value: unknown, signal: AbortSignal) {
        const input = planSchema.parse(value);
        const strategy = parseReplacementStrategy(input.strategy);
        const bytes = await (this.options.loadSource ?? downloadSourcePhoto)(
            input.sourceImageUrl,
            signal,
        );
        const analyzed = await decodeTemplateImage(bytes);
        if (
            hash(Buffer.from(analyzed.data, "base64")) !==
            input.analyzedImageSha256
        )
            throw new Error("分析后源图已变化，请重新规划");
        const metadata = await sharp(bytes).metadata();
        const sourceImageSha256 = hash(bytes);
        // 新方案在编译和审批前固定背景；历史方案仅从已批准的快照恢复。
        const requestedBackground = input.note
            ? strategy.outputBackground
            : null;
        const background =
            requestedBackground ??
            (analyzed.hasTransparency ? "transparent" : undefined);
        if (background) strategy.outputBackground = background;
        else delete strategy.outputBackground;
        const prompt = compileReplacementPrompt(strategy);
        const execution = {
            version: "v2" as const,
            prompt,
            promptSha256: hash(prompt),
        };
        const strategySha256 = hash(
            JSON.stringify({
                strategy,
                sourceImageSha256,
                ruleVersion: "image-producer-a52c876",
                revision: 2,
                execution,
            }),
        );
        const plan: Plan = {
            ...input,
            strategy,
            sourceImageSha256,
            strategySha256,
            execution,
            sourceMime:
                "image/" +
                (metadata.format === "jpeg" ? "jpeg" : metadata.format),
        };
        await mkdir(this.path(input.productionId, "."), { recursive: true });
        await writeFile(this.path(input.productionId, "source"), bytes, {
            flag: "wx",
            mode: 0o600,
        });
        await writeFile(
            this.path(input.productionId, "plan.json"),
            JSON.stringify(plan),
            { flag: "wx", mode: 0o600 },
        );
        return {
            productionId: input.productionId,
            strategySha256,
            sourceImageSha256,
            strategy,
            execution,
        };
    }
    private async render(
        input: z.infer<typeof renderInputSchema>,
        signal: AbortSignal,
    ) {
        return this.locked(input.productionId, async () => {
            const id = input.productionId;
            const prefix = input.renderId ? `renders/${input.renderId}/` : "";
            await mkdir(this.path(id, prefix || "."), { recursive: true });
            const plan = await this.read<Plan>(id, "plan.json");
            if (input.objectSha256 !== plan.strategySha256)
                throw new Error("方案已变化，确认失效");
            const existing = await this.optional<unknown>(
                id,
                `${prefix}review.json`,
            );
            if (existing) return existing;
            const renderer = this.options.renderer;
            if (!this.options.storage)
                throw new Error("未配置模板公读对象存储，禁止提交生图");
            let attempt = await this.optional<Attempt>(
                id,
                `${prefix}attempt.json`,
            );
            if ((!attempt || attempt.state === "approved") && !plan.execution)
                throw new TemplateImagePreparationError("reapproval_required");
            // 仅未派发的成图使用当前默认渠道；旧回执始终属于原渠道。
            const newSubmission = !attempt || attempt.state === "approved";
            const provider =
                attempt?.provider ??
                (newSubmission && this.options.editor ? "openai" : "fal");
            if (newSubmission && provider === "fal")
                assertFalTemplateBackground(plan.strategy.outputBackground);
            if (!attempt) {
                attempt = {
                    state: "approved",
                    provider,
                    approval: { ...input, decidedAt: new Date().toISOString() },
                };
                await this.save(id, `${prefix}attempt.json`, attempt);
            }
            const editor = this.options.editor;
            const rawResultPath = this.path(id, `${prefix}provider-result.png`);
            let bytes: Buffer | undefined;
            if (provider === "openai") {
                try {
                    bytes = await readFile(rawResultPath);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                        throw error;
                }
            }
            if (attempt.state === "submission_unknown" && !bytes)
                throw new TemplateImagePreparationError("submission_unknown");
            if (attempt.state === "provider_rejected")
                throw new TemplateImagePreparationError("provider_rejected");
            if (attempt.state === "approved") {
                if (provider === "openai" ? !editor : !renderer)
                    throw new Error("未配置原渠道图片服务");
                const execution = plan.execution;
                if (
                    execution?.version !== "v2" ||
                    hash(execution.prompt) !== execution.promptSha256 ||
                    hash(
                        JSON.stringify({
                            strategy: plan.strategy,
                            sourceImageSha256: plan.sourceImageSha256,
                            ruleVersion: "image-producer-a52c876",
                            revision: 2,
                            execution,
                        }),
                    ) !== plan.strategySha256
                )
                    throw new TemplateImagePreparationError(
                        "reapproval_required",
                    );
                const source = await readFile(this.path(id, "source"));
                if (hash(source) !== plan.sourceImageSha256)
                    throw new Error("源图摘要不匹配");
                let url: string | undefined;
                if (provider === "fal") {
                    if (!renderer) throw new Error("未配置原 FAL 图片服务");
                    url = await renderer.host(source, plan.sourceMime, signal);
                }
                signal.throwIfAborted();
                attempt.state = "submission_unknown";
                attempt.provider = provider;
                await this.save(id, `${prefix}attempt.json`, attempt);
                try {
                    if (provider === "openai") {
                        if (!editor) throw new Error("未配置图片网关");
                        const image = await editor.edit({
                            image: {
                                bytes: source,
                                mimeType: plan.sourceMime as
                                    | "image/png"
                                    | "image/jpeg"
                                    | "image/webp",
                            },
                            prompt: execution.prompt,
                            size: plan.strategy.image_size,
                            background:
                                plan.strategy.outputBackground ?? undefined,
                            idempotencyKey: input.renderId
                                ? `${id}-${input.renderId}`
                                : id,
                            signal,
                        });
                        bytes = image.bytes;
                        // 先持久保存供应商原字节；校验失败或进程重启均只重读该结果。
                        await writeFile(`${rawResultPath}.tmp`, bytes, {
                            mode: 0o600,
                            flush: true,
                        });
                        await rename(`${rawResultPath}.tmp`, rawResultPath);
                    } else {
                        if (!renderer || !url)
                            throw new Error("缺少原 FAL 托管图");
                        attempt.requestId = await renderer.submit(
                            url,
                            execution.prompt,
                            plan.strategy.image_size,
                            signal,
                            plan.strategy.outputBackground ?? undefined,
                        );
                    }
                } catch (error) {
                    const failure =
                        error instanceof TemplateImageSubmissionError
                            ? error
                            : new TemplateImageSubmissionError(
                                  "submission_unknown",
                              );
                    attempt.state = failure.type;
                    attempt.failure = {
                        type: failure.type,
                        ...(failure.httpStatus &&
                        failure.httpStatus >= 300 &&
                        failure.httpStatus <= 599
                            ? { httpStatus: failure.httpStatus }
                            : {}),
                    };
                    await this.save(id, `${prefix}attempt.json`, attempt);
                    throw new TemplateImagePreparationError(failure.type);
                }
                attempt = {
                    ...attempt,
                    state:
                        provider === "openai"
                            ? "provider_complete"
                            : "provider_pending",
                };
                await this.save(id, `${prefix}attempt.json`, attempt);
            }
            if (provider === "fal") {
                if (!renderer || !attempt.requestId)
                    throw new Error("缺少原 FAL 服务或可恢复请求");
                try {
                    bytes = await renderer.result(attempt.requestId, signal);
                } catch (error) {
                    if (error instanceof TemplateImageResultError) {
                        attempt.state = "provider_rejected";
                        attempt.failure = {
                            type: "provider_rejected",
                            httpStatus: error.httpStatus,
                        };
                        await this.save(id, `${prefix}attempt.json`, attempt);
                        throw new TemplateImagePreparationError(
                            "provider_rejected",
                        );
                    }
                    throw error;
                }
            }
            if (!bytes) throw new Error("缺少原渠道已保存成图，禁止重新提交");
            const meta = await sharp(bytes, {
                limitInputPixels: 40000000,
            }).metadata();
            const [width, height] = plan.strategy.image_size
                .split("x")
                .map(Number);
            if (
                bytes.length > 20000000 ||
                meta.format !== "png" ||
                (meta.pages ?? 1) !== 1 ||
                meta.width !== width ||
                meta.height !== height
            )
                throw new Error("成图格式或尺寸不符合合同");
            try {
                await assertImageBackground(
                    bytes,
                    plan.strategy.outputBackground ?? undefined,
                );
            } catch {
                throw new TemplateImagePreparationError("background_mismatch");
            }
            const imageSha256 = hash(bytes);
            if (imageSha256 === plan.sourceImageSha256)
                throw new Error("来源图不能直接作为产物");
            await writeFile(this.path(id, `${prefix}image.png`), bytes, {
                mode: 0o600,
                flush: true,
            });
            const reviewPackageSha256 = hash(
                JSON.stringify({
                    productionId: id,
                    ...(input.renderId ? { renderId: input.renderId } : {}),
                    strategySha256: plan.strategySha256,
                    sourceImageSha256: plan.sourceImageSha256,
                    imageSha256,
                    width,
                    height,
                }),
            );
            const review = {
                productionId: id,
                ...(input.renderId ? { renderId: input.renderId } : {}),
                imageSha256,
                reviewPackageSha256,
                width,
                height,
                imageDataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
            };
            await this.save(id, `${prefix}review.json`, review);
            await this.save(id, `${prefix}attempt.json`, {
                ...attempt,
                state: "image_ready",
            });
            return review;
        });
    }
    private async finalize(
        input: z.infer<typeof imageApprovalSchema>,
        signal: AbortSignal,
    ) {
        return this.locked(input.productionId, async () => {
            const id = input.productionId;
            const prefix = input.renderId ? `renders/${input.renderId}/` : "";
            const review = await this.read<{
                imageSha256: string;
                reviewPackageSha256: string;
                width: number;
                height: number;
            }>(id, `${prefix}review.json`);
            if (
                input.objectSha256 !== review.imageSha256 ||
                input.reviewPackageSha256 !== review.reviewPackageSha256
            )
                throw new Error("图片或审核包已变化，确认失效");
            const plan = await this.read<Plan>(id, "plan.json");
            const note = plan.note ? { note: plan.note } : {};
            const cached = await this.optional<unknown>(
                id,
                `${prefix}uploaded.json`,
            );
            if (cached)
                return {
                    ...preparedTemplateImageSchema.parse(cached),
                    ...note,
                };
            const storage = this.options.storage;
            if (!storage) throw new Error("未配置模板公读对象存储");
            const bytes = await readFile(this.path(id, `${prefix}image.png`));
            if (hash(bytes) !== input.objectSha256)
                throw new Error("成图摘要不匹配");
            // 审核事实先落盘，上传失败只恢复相同字节，不再次生图。
            const approval = await this.optional(
                id,
                `${prefix}image-approval.json`,
            );
            if (!approval)
                await this.save(id, `${prefix}image-approval.json`, {
                    ...input,
                    decidedAt: new Date().toISOString(),
                });
            const key = `gallery/template-images/${review.imageSha256}.png`;
            const stored = await storage.upload(
                {
                    objectKey: key,
                    bytes,
                    contentType: "image/png",
                    immutableSha256: review.imageSha256,
                    cacheControl: "public, max-age=31536000, immutable",
                },
                { signal },
            );
            if (
                stored.urlAccess !== "public" ||
                stored.url !== `https://assets.memebuy.cn/${key}`
            )
                throw new Error("模板图不是固定公读 OSS 地址");
            const image = preparedTemplateImageSchema.parse({
                url: stored.url,
                sha256: review.imageSha256,
                width: review.width,
                height: review.height,
                contentType: "image/png",
            });
            await this.save(id, `${prefix}uploaded.json`, image);
            await this.save(id, `${prefix}approved-image.json`, {
                schemaVersion: 2,
                status: "approved_uploaded",
                image: {
                    uri: image.url,
                    sha256: image.sha256,
                    width: image.width,
                    height: image.height,
                    mime: image.contentType,
                },
            });
            return { ...image, ...note };
        });
    }
}
