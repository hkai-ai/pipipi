import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import { TemplateImageProduction } from "../src/business-api/template-image-production.js";
import {
    createProcessAttemptRunner,
    defineProcessRegistration,
} from "../src/process-runtime/index.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import {
    compileTemplateResult,
    templateInputSchema,
    templateOutputSchema,
} from "../src/processes/template-from-image/contract.js";
import { decodeTemplateImage } from "../src/processes/template-from-image/image.js";
import {
    finalizedTemplateImageSchema,
    type TemplateImagePreparation,
} from "../src/processes/template-from-source/capability.js";
import {
    createTemplatePlanRegistration,
    createTemplateRenderRegistration,
    createTemplateSourceRegistration,
} from "../src/processes/template-from-source/registration.js";
import { parseReplacementStrategy } from "../src/processes/template-from-source/strategy.js";
import { candidate } from "./fixtures/template-candidate.js";
import { imageStrategy } from "./fixtures/template-image-strategy.js";

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true });
});
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function setup(large = false) {
    const directory = await mkdtemp(join(tmpdir(), "pi-template-production-"));
    roots.push(directory);
    const source = await sharp({
        create: {
            width: 1024,
            height: 1024,
            channels: 3,
            background: "#eeeeee",
        },
    })
        .png()
        .toBuffer();
    const generated = large
        ? await sharp(
              Buffer.from(
                  Array.from(
                      { length: 1024 * 1024 * 3 },
                      (_, i) =>
                          ((i * 1664525 + (i >>> 8) * 1013904223) >>> 16) & 255,
                  ),
              ),
              { raw: { width: 1024, height: 1024, channels: 3 } },
          )
              .png({ compressionLevel: 0 })
              .toBuffer()
        : await sharp({
              create: {
                  width: 1024,
                  height: 1024,
                  channels: 3,
                  background: "#bb7722",
              },
          })
              .png()
              .toBuffer();
    const sourceImage = await decodeTemplateImage(source);
    const renderer = {
        host: vi.fn(
            async (_bytes: Buffer, _mime: string, _signal: AbortSignal) =>
                "https://images.example.com/hosted.png",
        ),
        submit: vi.fn(async () => "request-1"),
        result: vi.fn(async () => generated),
    };
    const upload = vi.fn(async (input: { objectKey: string }) => ({
        provider: "aliyun-oss",
        bucket: "fixture",
        objectKey: input.objectKey,
        url: `https://assets.memebuy.cn/${input.objectKey}`,
        urlAccess: "public" as const,
        contentType: "image/png",
        size: generated.length,
    }));
    const service = new TemplateImageProduction({
        directory,
        renderer,
        storage: { provider: "aliyun-oss", upload },
        loadSource: async () => source,
    });
    const preparation: TemplateImagePreparation = {
        savePlan: (input, signal) => service.execute("plans", input, signal),
        render: (input, signal) => service.execute("render", input, signal),
        finalize: async (input, signal) =>
            finalizedTemplateImageSchema.parse(
                await service.execute("finalize", input, signal),
            ),
    };
    const compile = vi.fn(async (input: { imageUrl: string }) => ({
        template: compileTemplateResult(
            candidate(),
            input.imageUrl,
            sourceImage,
        ),
    }));
    const compiler = defineProcessRegistration({
        id: "template-from-image",
        version: "v1",
        inputSchema: templateInputSchema,
        outputSchema: templateOutputSchema,
        activities: [],
        execute: compile,
    });
    const app = createProcessingApplication({
        executor: createProcessExecutor({
            registrations: [
                createTemplatePlanRegistration({
                    preparation,
                    agent: { plan: async () => imageStrategy() },
                    loadImage: async () => sourceImage,
                }),
                createTemplateRenderRegistration(preparation),
                createTemplateSourceRegistration({
                    preparation,
                    compiler,
                    attemptRunner: createProcessAttemptRunner(),
                }),
            ],
        }),
    });
    const { url } = await app.listen();
    async function execute(process: string, input: unknown) {
        const response = await fetch(`${url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ process, version: "v1", input }),
        });
        return {
            status: response.status,
            body: (await response.json()) as {
                output: Record<string, unknown>;
            },
        };
    }
    return {
        directory,
        source,
        sourceImage,
        generated,
        renderer,
        upload,
        service,
        app,
        execute,
        compile,
    };
}
it("真实 HTTP 三阶段分别暂停，摘要错误不生图、不上传，重复确认只恢复原图", async () => {
    const s = await setup(true);
    try {
        const plan = await s.execute("template-image-plan", {
            imageUrl: "https://images.example.com/source.png",
            note: "保留原有文字布局",
        });
        expect(plan.status).toBe(200);
        expect(s.renderer.submit).not.toHaveBeenCalled();
        expect(s.upload).not.toHaveBeenCalled();
        const productionId = String(plan.body.output.productionId);
        expect(
            (
                await s.execute("template-from-source", {
                    productionId,
                    objectSha256: "0".repeat(64),
                    reviewPackageSha256: "0".repeat(64),
                    reviewerRef: "operator",
                })
            ).status,
        ).not.toBe(200);
        expect(
            (
                await s.execute("template-image-render", {
                    productionId,
                    objectSha256: "0".repeat(64),
                    reviewerRef: "operator",
                })
            ).status,
        ).not.toBe(200);
        expect(s.renderer.submit).not.toHaveBeenCalled();
        const strategyApproval = {
            productionId,
            objectSha256: plan.body.output.strategySha256,
            reviewerRef: "operator",
        };
        const rendered = await s.execute(
            "template-image-render",
            strategyApproval,
        );
        expect(rendered.status).toBe(200);
        expect(s.upload).not.toHaveBeenCalled();
        expect(s.compile).not.toHaveBeenCalled();
        expect(s.renderer.submit).toHaveBeenCalledTimes(1);
        expect(s.renderer.host.mock.calls[0]?.[0]).toEqual(s.source);
        expect(
            (await s.execute("template-image-render", strategyApproval)).body
                .output,
        ).toEqual(rendered.body.output);
        expect(s.renderer.submit).toHaveBeenCalledTimes(1);
        const imageApproval = {
            productionId,
            objectSha256: rendered.body.output.imageSha256,
            reviewPackageSha256: rendered.body.output.reviewPackageSha256,
            reviewerRef: "operator",
        };
        expect(
            (
                await s.execute("template-from-source", {
                    ...imageApproval,
                    reviewPackageSha256: "0".repeat(64),
                })
            ).status,
        ).not.toBe(200);
        expect(s.upload).not.toHaveBeenCalled();
        const finalized = await s.execute(
            "template-from-source",
            imageApproval,
        );
        expect(finalized.status).toBe(200);
        expect(s.compile.mock.calls[0]?.[0]).toMatchObject({
            note: "保留原有文字布局",
        });
        expect(finalized.body.output.preparedImage).not.toHaveProperty("note");
        const expected =
            "https://assets.memebuy.cn/gallery/template-images/" +
            sha(s.generated) +
            ".png";
        expect(finalized.body.output.template).toMatchObject({
            cover: expected,
            referenceImage: expected,
        });
        expect(s.upload).toHaveBeenCalledTimes(1);
        expect(
            (await s.execute("template-from-source", imageApproval)).status,
        ).toBe(200);
        expect(s.upload).toHaveBeenCalledTimes(1);
        expect(s.renderer.submit).toHaveBeenCalledTimes(1);
        expect(
            JSON.parse(
                await readFile(
                    join(s.directory, productionId, "image-approval.json"),
                    "utf8",
                ),
            ),
        ).toMatchObject(imageApproval);
    } finally {
        await s.app.close();
    }
});
it("生成 POST 失联后保持未知提交，重试不能再次付费", async () => {
    const s = await setup();
    try {
        const plan = await s.execute("template-image-plan", {
            imageUrl: "https://images.example.com/source.png",
        });
        s.renderer.submit.mockRejectedValueOnce(new Error("transport lost"));
        const approval = {
            productionId: plan.body.output.productionId,
            objectSha256: plan.body.output.strategySha256,
            reviewerRef: "operator",
        };
        expect(
            (await s.execute("template-image-render", approval)).status,
        ).not.toBe(200);
        expect(
            (await s.execute("template-image-render", approval)).status,
        ).not.toBe(200);
        expect(s.renderer.submit).toHaveBeenCalledTimes(1);
        expect(s.upload).not.toHaveBeenCalled();
    } finally {
        await s.app.close();
    }
});
it("分类、替换目标、闭包和文字权限必须符合来源规则", () => {
    const original = imageStrategy();
    expect(() => parseReplacementStrategy(original)).not.toThrow();
    for (const mutate of [
        (s: ReturnType<typeof imageStrategy>) => {
            s.selectedCategory = "dog";
        },
        (s: ReturnType<typeof imageStrategy>) => {
            s.selectedIdentityFingerprint = s.sourceIdentityFingerprint;
        },
        (s: ReturnType<typeof imageStrategy>) => {
            s.featureAuthority = [];
        },
        (s: ReturnType<typeof imageStrategy>) => {
            s.markActions[0].action = "preserve";
        },
    ]) {
        const s = structuredClone(original);
        mutate(s);
        expect(() => parseReplacementStrategy(s)).toThrow();
    }
});
