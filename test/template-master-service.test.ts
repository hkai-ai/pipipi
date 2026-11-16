/** 母版改图与上传内部服务：尺寸校验、拒绝与未知分类、内容寻址上传，使用测试替身。 */
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { TemplateImageSubmissionError } from "../src/business-api/template-image-submission.js";
import {
    TemplateMasterError,
    TemplateMasterService,
} from "../src/business-api/template-master.js";

const png = (size: number) =>
    sharp({
        create: { width: size, height: size, channels: 3, background: "#fff" },
    })
        .png()
        .toBuffer();
const signal = new AbortController().signal;

describe("TemplateMasterService", () => {
    it("返回尺寸与请求一致的 PNG，拒绝与未知分别归类", async () => {
        const ok = new TemplateMasterService({
            editor: { edit: async () => png(1024) },
        });
        const request = {
            image: (await png(512)).toString("base64"),
            prompt: "p",
            size: "1024x1024",
            idempotencyKey: "k",
        };
        expect(await ok.execute("edit", request, signal)).toHaveProperty(
            "image",
        );
        const wrong = new TemplateMasterService({
            editor: { edit: async () => png(512) },
        });
        await expect(
            wrong.execute("edit", request, signal),
        ).rejects.toMatchObject({ reason: "unknown" });
        const rejected = new TemplateMasterService({
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
            rejected.execute("edit", request, signal),
        ).rejects.toMatchObject({ reason: "rejected" });
        await expect(
            rejected.execute("edit", request, signal),
        ).rejects.toBeInstanceOf(TemplateMasterError);
    });
    it("按内容摘要上传到固定公读地址", async () => {
        const upload = vi.fn(async (r: { objectKey: string }) => ({
            url: `https://assets.memebuy.cn/${r.objectKey}`,
            urlAccess: "public" as const,
        }));
        const service = new TemplateMasterService({
            storage: { provider: "t", upload } as never,
        });
        const result = (await service.execute(
            "upload",
            { image: (await png(300)).toString("base64") },
            signal,
        )) as { sha256: string; url: string; width: number };
        expect(result.url).toBe(
            `https://assets.memebuy.cn/gallery/template-images/${result.sha256}.png`,
        );
        expect(result.width).toBe(300);
        const bad = new TemplateMasterService({
            storage: {
                provider: "t",
                upload: async () => ({
                    url: "https://x/y.png",
                    urlAccess: "public",
                }),
            } as never,
        });
        await expect(
            bad.execute(
                "upload",
                { image: (await png(300)).toString("base64") },
                signal,
            ),
        ).rejects.toMatchObject({ reason: "upload" });
    });
});
