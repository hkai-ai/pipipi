import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import { TemplateImageSubmissionError } from "../src/business-api/template-image-fal.js";
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

it("同一方案新 renderId 真正重做，旧 renderId 恢复原结果，审批不能跨成图版本", async () => {
    const s = await setup();
    try {
        const plan = await s.execute("template-image-plan", {
            imageUrl: "https://example.com/source.png",
            note: "保持原要求",
        });
        const approval = {
            productionId: plan.body.output.productionId,
            objectSha256: plan.body.output.strategySha256,
            reviewerRef: "operator",
        };
        const firstInput = { ...approval, renderId: randomUUID() };
        const secondInput = { ...approval, renderId: randomUUID() };
        const first = await s.execute("template-image-render", firstInput);
        const second = await s.execute("template-image-render", secondInput);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(s.renderer.submit).toHaveBeenCalledTimes(2);
        expect(s.upload).not.toHaveBeenCalled();
        expect(
            (await s.execute("template-image-render", firstInput)).body.output,
        ).toEqual(first.body.output);
        expect(s.renderer.submit).toHaveBeenCalledTimes(2);
        expect(first.body.output.reviewPackageSha256).not.toBe(
            second.body.output.reviewPackageSha256,
        );
        const imageApproval = {
            productionId: approval.productionId,
            renderId: firstInput.renderId,
            objectSha256: first.body.output.imageSha256,
            reviewPackageSha256: first.body.output.reviewPackageSha256,
            reviewerRef: "operator",
        };
        expect(
            (
                await s.execute("template-from-source", {
                    ...imageApproval,
                    renderId: secondInput.renderId,
                })
            ).status,
        ).not.toBe(200);
        expect(s.upload).not.toHaveBeenCalled();
        expect(
            (await s.execute("template-from-source", imageApproval)).status,
        ).toBe(200);
        expect(s.compile).toHaveBeenCalledTimes(1);
        expect(
            (await s.execute("template-from-source", imageApproval)).status,
        ).toBe(200);
        expect(s.compile).toHaveBeenCalledTimes(2);
        expect(s.renderer.submit).toHaveBeenCalledTimes(2);
        expect(s.upload).toHaveBeenCalledTimes(1);
    } finally {
        await s.app.close();
    }
});

it("具名成图提交未知时复用 renderId 不会再次付费", async () => {
    const s = await setup();
    try {
        const plan = await s.execute("template-image-plan", {
            imageUrl: "https://example.com/source.png",
        });
        const input = {
            productionId: plan.body.output.productionId,
            objectSha256: plan.body.output.strategySha256,
            reviewerRef: "operator",
            renderId: randomUUID(),
        };
        s.renderer.submit.mockRejectedValueOnce(new Error("connection lost"));
        expect(
            (await s.execute("template-image-render", input)).status,
        ).not.toBe(200);
        expect(
            (await s.execute("template-image-render", input)).status,
        ).not.toBe(200);
        expect(s.renderer.submit).toHaveBeenCalledTimes(1);
    } finally {
        await s.app.close();
    }
});
afterEach(async () => {
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true });
});
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function setup(
    large = false,
    planOptions: Partial<
        Parameters<typeof createTemplatePlanRegistration>[0]
    > = {},
) {
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
        result: vi.fn(
            async (_requestId: string, _signal: AbortSignal) => generated,
        ),
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
                    ...planOptions,
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
        const approvalBefore = await readFile(
            join(s.directory, productionId, "image-approval.json"),
            "utf8",
        );
        const recompiled = await s.execute("template-from-source", {
            ...imageApproval,
            note: "主副标题应允许分别替换",
        });
        expect(recompiled.status).toBe(200);
        expect(s.compile).toHaveBeenCalledTimes(2);
        expect(s.compile.mock.calls[1]?.[0]).toMatchObject({
            imageUrl: expected,
            note: "主副标题应允许分别替换",
        });
        expect(recompiled.body.output.preparedImage).toEqual(
            finalized.body.output.preparedImage,
        );
        expect(s.upload).toHaveBeenCalledTimes(1);
        expect(s.renderer.submit).toHaveBeenCalledTimes(1);
        expect(s.renderer.host).toHaveBeenCalledTimes(1);
        expect(
            await readFile(
                join(s.directory, productionId, "image-approval.json"),
                "utf8",
            ),
        ).toBe(approvalBefore);
        expect(
            (await s.execute("template-from-source", imageApproval)).status,
        ).toBe(200);
        expect(s.compile.mock.calls[2]?.[0]).toMatchObject({
            note: "保留原有文字布局",
        });
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

it("策略字段校验失败后只修正一次，完整复验后才保存", async () => {
    const strategy = imageStrategy();
    strategy.targetCanvas.excludedScopes = [];
    const repair = vi.fn(async () => ({
        changes: [
            {
                field: "targetCanvas",
                valueJson: JSON.stringify(imageStrategy().targetCanvas),
            },
        ],
    }));
    const onDiagnostic = vi.fn(() => {
        throw new Error("PRIVATE-SINK");
    });
    const s = await setup(false, {
        agent: { plan: async () => strategy, repair },
        onDiagnostic,
    });
    try {
        const result = await s.execute("template-image-plan", {
            imageUrl: "https://images.example.com/source.png",
        });
        expect(result.status).toBe(200);
        expect(repair).toHaveBeenCalledTimes(1);
        expect(onDiagnostic).toHaveBeenCalledWith(
            expect.objectContaining({
                stage: "plan_validation",
                issues: expect.arrayContaining([
                    expect.objectContaining({
                        code: "canvas_exclusions",
                    }),
                ]),
            }),
        );
        expect(s.renderer.submit).not.toHaveBeenCalled();
        expect(s.upload).not.toHaveBeenCalled();
    } finally {
        await s.app.close();
    }
});

it("无效补丁只失败一次且不保存，诊断不包含候选或原始异常", async () => {
    const strategy = imageStrategy();
    strategy.selectedIdentityFingerprint = strategy.sourceIdentityFingerprint;
    strategy.risks = ["PRIVATE-CANDIDATE"];
    const repair = vi.fn(async () => ({
        changes: [
            {
                field: "selectedIdentityFingerprint",
                valueJson: JSON.stringify(strategy.sourceIdentityFingerprint),
            },
        ],
    }));
    const savePlan = vi.fn();
    const diagnostics: unknown[] = [];
    const s = await setup(false, {
        agent: { plan: async () => strategy, repair },
        preparation: { savePlan, render: vi.fn(), finalize: vi.fn() },
        onDiagnostic: (record) => {
            diagnostics.push(record);
            throw new Error("PRIVATE-SINK");
        },
    });
    try {
        const result = await s.execute("template-image-plan", {
            imageUrl: "https://images.example.com/source.png",
        });
        expect(result.status).toBe(502);
        expect(repair).toHaveBeenCalledTimes(1);
        expect(savePlan).not.toHaveBeenCalled();
        expect(JSON.stringify(diagnostics)).toContain("different_identity");
        expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE-");
        expect(JSON.stringify(result.body)).not.toContain("PRIVATE-");
    } finally {
        await s.app.close();
    }
});

it("模型执行错误只记录阶段，不重投请求或泄漏错误", async () => {
    const repair = vi.fn();
    const onDiagnostic = vi.fn();
    const s = await setup(false, {
        agent: {
            plan: async () => {
                throw new Error("SECRET-ERROR");
            },
            repair,
        },
        onDiagnostic,
    });
    try {
        const result = await s.execute("template-image-plan", {
            imageUrl: "https://images.example.com/source.png",
        });
        expect(result.status).toBe(502);
        expect(repair).not.toHaveBeenCalled();
        expect(onDiagnostic).toHaveBeenCalledWith(
            expect.objectContaining({
                stage: "replacement_planning",
                issues: [],
            }),
        );
        expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain(
            "SECRET-ERROR",
        );
    } finally {
        await s.app.close();
    }
});

it("明确拒绝持久化安全分类且批准不能复用，锁在错误后释放", async () => {
    const s = await setup();
    try {
        const plan = await s.execute("template-image-plan", {
            imageUrl: "https://example.com/source.png",
        });
        const productionId = String(plan.body.output.productionId);
        const approval = {
            productionId,
            objectSha256: plan.body.output.strategySha256,
            reviewerRef: "operator",
        };
        s.renderer.submit.mockRejectedValueOnce(
            new TemplateImageSubmissionError("provider_rejected", 422),
        );
        const rejected = await s.execute("template-image-render", approval);
        expect(JSON.stringify(rejected.body)).toContain("明确拒绝");
        const saved = JSON.parse(
            await readFile(
                join(s.directory, productionId, "attempt.json"),
                "utf8",
            ),
        );
        expect(saved).toMatchObject({
            state: "provider_rejected",
            failure: { type: "provider_rejected", httpStatus: 422 },
        });
        await expect(
            readFile(join(s.directory, productionId, "operation.lock")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await s.execute("template-image-render", approval);
        expect(s.renderer.submit).toHaveBeenCalledTimes(1);
    } finally {
        await s.app.close();
    }
});
it("新指令落盘并绑定批准，不能篡改内容后执行", async () => {
    const s = await setup();
    try {
        const plan = await s.execute("template-image-plan", {
            imageUrl: "https://example.com/source.png",
        });
        const productionId = String(plan.body.output.productionId);
        const file = join(s.directory, productionId, "plan.json");
        const saved = JSON.parse(await readFile(file, "utf8"));
        expect(saved.execution).toEqual(plan.body.output.execution);
        expect(saved.execution.promptSha256).toBe(
            sha(Buffer.from(saved.execution.prompt)),
        );
        saved.execution.prompt = "篡改的生图指令";
        saved.execution.promptSha256 = sha(Buffer.from(saved.execution.prompt));
        await writeFile(file, JSON.stringify(saved));
        const result = await s.execute("template-image-render", {
            productionId,
            objectSha256: plan.body.output.strategySha256,
            reviewerRef: "operator",
        });
        expect(result.status).not.toBe(200);
        expect(s.renderer.host).not.toHaveBeenCalled();
        expect(s.renderer.submit).not.toHaveBeenCalled();
    } finally {
        await s.app.close();
    }
});
it.each([false, true])(
    "旧方案未提交时需要重新批准，已有批准=%s",
    async (approved) => {
        const s = await setup();
        try {
            const plan = await s.execute("template-image-plan", {
                imageUrl: "https://example.com/source.png",
            });
            const productionId = String(plan.body.output.productionId);
            const file = join(s.directory, productionId, "plan.json");
            const saved = JSON.parse(await readFile(file, "utf8"));
            delete saved.execution;
            await writeFile(file, JSON.stringify(saved));
            const approval = {
                productionId,
                objectSha256: plan.body.output.strategySha256,
                reviewerRef: "operator",
            };
            if (approved)
                await writeFile(
                    join(s.directory, productionId, "attempt.json"),
                    JSON.stringify({ state: "approved", approval }),
                );
            const result = await s.execute("template-image-render", approval);
            expect(JSON.stringify(result.body)).toContain("重新规划和确认");
            expect(s.renderer.submit).not.toHaveBeenCalled();
        } finally {
            await s.app.close();
        }
    },
);
it("已知请求取消等待后，旧方案也能恢复原请求且不重提交", async () => {
    const s = await setup();
    try {
        const plan = await s.execute("template-image-plan", {
            imageUrl: "https://example.com/source.png",
        });
        const productionId = String(plan.body.output.productionId);
        const approval = {
            productionId,
            objectSha256: plan.body.output.strategySha256,
            reviewerRef: "operator",
        };
        s.renderer.result.mockRejectedValueOnce(new Error("cancelled"));
        expect(
            (await s.execute("template-image-render", approval)).status,
        ).not.toBe(200);
        const file = join(s.directory, productionId, "plan.json");
        const saved = JSON.parse(await readFile(file, "utf8"));
        delete saved.execution;
        await writeFile(file, JSON.stringify(saved));
        expect(
            (await s.execute("template-image-render", approval)).status,
        ).toBe(200);
        expect(s.renderer.submit).toHaveBeenCalledTimes(1);
        expect(s.renderer.result.mock.calls.map((call) => call[0])).toEqual([
            "request-1",
            "request-1",
        ]);
    } finally {
        await s.app.close();
    }
});
