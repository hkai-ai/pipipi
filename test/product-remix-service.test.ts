/** 商品做同款内部 Business API、多参考图编辑客户端与费用账本回传测试。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCrtBusinessApi } from "../src/business-api/crt-server.js";
import { OpenAIImageGenerationClient } from "../src/business-api/openai-image-generation.js";
import {
    ProductRemixService,
    ProductRemixServiceError,
} from "../src/business-api/product-remix.js";
import { TemplateImageSubmissionError } from "../src/business-api/template-image-submission.js";
import {
    createCostLedger,
    recordKnownCost,
    withCostLedger,
} from "../src/process-runtime/cost.js";
import { HttpProductRemixCapability } from "../src/processes/product-remix/capability.http.js";
import { ProductRemixCapabilityError } from "../src/processes/product-remix/capability.js";

const png = (width: number, height: number, background = "#fff") =>
    sharp({
        create: { width, height, channels: 3, background },
    })
        .png()
        .toBuffer();

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirs
            .splice(0)
            .map((dir) => rm(dir, { recursive: true, force: true })),
    );
});

describe("OpenAIImageGenerationClient 多参考图编辑", () => {
    it("按顺序发送多张 image[] multipart 表单并记录费用响应头", async () => {
        const img1 = await png(64, 64, "#111");
        const img2 = await png(64, 64, "#222");
        const output = await png(128, 128, "#333");
        let sentImages: Array<{ name: string; size: number; type: string }> =
            [];

        const client = new OpenAIImageGenerationClient({
            apiKey: "test-key",
            baseUrl: "https://gateway.example/v1",
            fetch: async (_url, init) => {
                const body = init?.body as FormData;
                const entries = body.getAll("image[]");
                sentImages = entries.map((entry) => {
                    const file = entry as File;
                    return {
                        name: file.name,
                        size: file.size,
                        type: file.type,
                    };
                });
                return Response.json(
                    { data: [{ b64_json: output.toString("base64") }] },
                    { headers: { "x-litellm-response-cost": "0.085" } },
                );
            },
        });

        const ledger = createCostLedger();
        const result = await withCostLedger(ledger, () =>
            client.edit(
                {
                    images: [
                        {
                            bytes: img1,
                            mimeType: "image/png",
                            filename: "remix-1.png",
                        },
                        {
                            bytes: img2,
                            mimeType: "image/png",
                            filename: "remix-2.png",
                        },
                    ],
                    prompt: "Remix subject from second image into style of first.",
                    size: "1024x1024",
                    model: "gpt-image-2.5-flare",
                    quality: "low",
                    outputFormat: "png",
                    idempotencyKey: "k-multi",
                },
                { singleDispatch: true },
            ),
        );

        expect(sentImages).toEqual([
            { name: "remix-1.png", size: img1.byteLength, type: "image/png" },
            { name: "remix-2.png", size: img2.byteLength, type: "image/png" },
        ]);
        expect(result.bytes.equals(output)).toBe(true);
        expect(ledger.summary()).toEqual({
            currency: "USD",
            amount: 0.085,
            source: "provider",
            complete: true,
        });
    });
});

describe("ProductRemixService", () => {
    const signal = new AbortController().signal;

    it("转发多图编辑并返回真实尺寸与模型标识", async () => {
        const src1 = await png(512, 512);
        const src2 = await png(512, 512, "#aaa");
        const out = await png(896, 1152);
        const editorEdit = vi.fn(async () => out);

        const service = new ProductRemixService({
            editor: { modelName: "gpt-image-2.5-flare", edit: editorEdit },
        });
        const response = (await service.execute(
            "edit",
            {
                images: [
                    { data: src1.toString("base64"), mimeType: "image/png" },
                    { data: src2.toString("base64"), mimeType: "image/png" },
                ],
                prompt: "edit prompt",
                size: "896x1152",
                idempotencyKey: "remix-1",
            },
            signal,
        )) as {
            width: number;
            height: number;
            modelName: string;
            image: string;
        };

        expect(editorEdit).toHaveBeenCalledOnce();
        expect(response.width).toBe(896);
        expect(response.height).toBe(1152);
        expect(response.modelName).toBe("gpt-image-2.5-flare");
        expect(Buffer.from(response.image, "base64").equals(out)).toBe(true);
    });

    it("把供应商拒绝和非法图像分别归类为 rejected 和 unknown", async () => {
        const src = await png(256, 256);
        const request = {
            images: [{ data: src.toString("base64"), mimeType: "image/png" }],
            prompt: "p",
            size: "1024x1024",
            idempotencyKey: "k1",
        };

        const rejectedService = new ProductRemixService({
            editor: {
                edit: async () => {
                    throw new TemplateImageSubmissionError(
                        "provider_rejected",
                        400,
                    );
                },
            },
        });
        await expect(
            rejectedService.execute("edit", request, signal),
        ).rejects.toMatchObject({ reason: "rejected" });

        const badImageService = new ProductRemixService({
            editor: { edit: async () => Buffer.from("corrupted") },
        });
        await expect(
            badImageService.execute("edit", request, signal),
        ).rejects.toBeInstanceOf(ProductRemixServiceError);
        await expect(
            badImageService.execute("edit", request, signal),
        ).rejects.toMatchObject({ reason: "unknown" });
    });

    it("上传到受控对象存储并校验返回 URL 红线", async () => {
        const image = await png(1024, 1024);
        const upload = vi.fn(async (req: { objectKey: string }) => ({
            provider: "aliyun-oss",
            bucket: "pipipi-bucket",
            objectKey: req.objectKey,
            url: `https://assets.example.com/${req.objectKey}?OSSAccessKeyId=x&Expires=999&Signature=sig`,
            urlAccess: "signed" as const,
            contentType: "image/png",
            size: image.byteLength,
        }));

        const okService = new ProductRemixService({
            storage: { provider: "aliyun-oss", upload },
        });
        const uploaded = (await okService.execute(
            "upload",
            { image: image.toString("base64") },
            signal,
        )) as { url: string; width: number; height: number };

        expect(uploaded.width).toBe(1024);
        expect(uploaded.height).toBe(1024);
        expect(uploaded.url).toMatch(
            /^https:\/\/assets\.example\.com\/product-remix\/[a-f0-9]{64}\.png\?/,
        );

        const badUrlService = new ProductRemixService({
            storage: {
                provider: "aliyun-oss",
                upload: async () => ({
                    provider: "aliyun-oss",
                    bucket: "b",
                    objectKey: "k",
                    url: "https://assets.example.com/k.png?x-oss-process=image/resize,w_200",
                    urlAccess: "signed" as const,
                    contentType: "image/png",
                    size: 100,
                }),
            },
        });
        await expect(
            badUrlService.execute(
                "upload",
                { image: image.toString("base64") },
                signal,
            ),
        ).rejects.toMatchObject({ reason: "upload" });

        const missingStorageService = new ProductRemixService({});
        await expect(
            missingStorageService.execute(
                "upload",
                { image: image.toString("base64") },
                signal,
            ),
        ).rejects.toMatchObject({ reason: "upload" });
    });
});

describe("HttpProductRemixCapability 与内部 Business API 集成", () => {
    it("通过 /product-remix/edit 与 /product-remix/upload 完成编辑上传并回传费用账本", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pipipi-remix-api-"));
        tempDirs.push(dir);
        const src = await png(512, 512);
        const out = await png(1024, 1024, "#bfdbfe");

        const api = await startCrtBusinessApi({
            directory: dir,
            imageClient: {
                edit: async () => {
                    throw new Error("unused");
                },
            },
            templateEditor: {
                modelName: "gpt-image-2.5-flare",
                edit: async () => {
                    recordKnownCost(0.042, "provider");
                    return out;
                },
            },
            storage: {
                provider: "aliyun-oss",
                upload: async (req) => ({
                    provider: "aliyun-oss",
                    bucket: "bucket",
                    objectKey: req.objectKey,
                    url: `https://cdn.example.com/${req.objectKey}`,
                    urlAccess: "public",
                    contentType: "image/png",
                    size: req.bytes.byteLength,
                }),
            },
        });

        try {
            const capability = new HttpProductRemixCapability(api.url);
            const ledger = createCostLedger();
            const signal = new AbortController().signal;

            const edited = await withCostLedger(ledger, () =>
                capability.edit({
                    images: [{ bytes: src, mimeType: "image/png" }],
                    prompt: "change palette",
                    size: "1024x1024",
                    idempotencyKey: "remix-http-1",
                    signal,
                }),
            );
            expect(edited.modelName).toBe("gpt-image-2.5-flare");
            expect(edited.width).toBe(1024);

            const uploaded = await withCostLedger(ledger, () =>
                capability.upload(edited.bytes, signal),
            );
            expect(uploaded.url).toMatch(
                /^https:\/\/cdn\.example\.com\/product-remix\/[a-f0-9]{64}\.png$/,
            );
            expect(ledger.summary()).toEqual({
                currency: "USD",
                amount: 0.042,
                source: "provider",
                complete: true,
            });
        } finally {
            await api.close();
        }
    });

    it("Business API 返回 503 时还原受控 Capability 错误原因", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pipipi-remix-api-err-"));
        tempDirs.push(dir);
        const src = await png(256, 256);

        const api = await startCrtBusinessApi({
            directory: dir,
            imageClient: {
                edit: async () => {
                    throw new Error("unused");
                },
            },
            templateEditor: {
                edit: async () => {
                    throw new TemplateImageSubmissionError(
                        "provider_rejected",
                        400,
                    );
                },
            },
        });

        try {
            const capability = new HttpProductRemixCapability(api.url);
            await expect(
                capability.edit({
                    images: [{ bytes: src, mimeType: "image/png" }],
                    prompt: "reject me",
                    size: "1024x1024",
                    idempotencyKey: "remix-reject-1",
                    signal: new AbortController().signal,
                }),
            ).rejects.toEqual(new ProductRemixCapabilityError("rejected"));
        } finally {
            await api.close();
        }
    });
});
