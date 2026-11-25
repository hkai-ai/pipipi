/** 模板母版 v2 显式单次修图契约、提示词、基础可印校验、执行治理与 HTTP 透传测试。 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessingApplication } from "../src/api/application.js";
import { constructProcessingService } from "../src/app/api.js";
import {
    type CrtBusinessApi,
    startCrtBusinessApi,
} from "../src/business-api/crt-server.js";
import { createProcessAttemptRunner } from "../src/process-runtime/index.js";
import { draftSchema } from "../src/processes/template-from-image/design-spec/contract.js";
import { HttpTemplateMasterCapability } from "../src/processes/template-master/capability.http.js";
import {
    MasterCapabilityError,
    type MasterEditRequest,
    type TemplateMasterCapability,
    templateMasterV2ImageModel,
} from "../src/processes/template-master/capability.js";
import { checkV2Printable } from "../src/processes/template-master/checks.js";
import {
    masterV2InputSchema,
    masterV2OutputSchema,
} from "../src/processes/template-master/contract.js";
import { buildV2EditInstruction } from "../src/processes/template-master/method.js";
import {
    createTemplateMasterV2Registration,
    templateMasterV2TimeoutMs,
} from "../src/processes/template-master/v2.js";

const fixture = JSON.parse(
    readFileSync(
        new URL("./fixtures/template-v4-candidate.json", import.meta.url),
        "utf8",
    ),
);
const template = draftSchema.parse(fixture.draft);
const spec = template.runtimeSemantics.designSpec;
const sourceUrl = "https://assets.example.com/source.png";

async function opaquePng(width: number, height: number): Promise<Buffer> {
    return sharp({
        create: { width, height, channels: 3, background: "#ffffff" },
    })
        .png()
        .toBuffer();
}

async function transparentCirclePng(size: number): Promise<Buffer> {
    const data = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const inside = Math.hypot(x - size / 2, y - size / 2) <= size * 0.3;
            const offset = (y * size + x) * 4;
            data[offset] = inside ? 32 : 0;
            data[offset + 1] = inside ? 50 : 0;
            data[offset + 2] = inside ? 76 : 0;
            data[offset + 3] = inside ? 255 : 0;
        }
    }
    return sharp(data, { raw: { width: size, height: size, channels: 4 } })
        .png()
        .toBuffer();
}

async function emptyTransparentPng(size: number): Promise<Buffer> {
    return sharp({
        create: {
            width: size,
            height: size,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .png()
        .toBuffer();
}

function makeUploaded(png: Buffer) {
    const sha256 = createHash("sha256").update(png).digest("hex");
    return {
        url: `https://assets.memebuy.cn/gallery/template-images/${sha256}.png`,
        sha256,
        width: 1024,
        height: 1024,
        contentType: "image/png" as const,
    };
}

const closers: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("template-master/v2 契约与基础可印校验", () => {
    it("接受三种显式修图意图、可选 template 与可选 watermarkNote，拒绝非法组合", () => {
        expect(
            masterV2InputSchema.safeParse({
                imageUrl: sourceUrl,
                operation: "transparent_only",
                transparent: true,
            }).success,
        ).toBe(true);

        expect(
            masterV2InputSchema.safeParse({
                imageUrl: sourceUrl,
                operation: "remove_watermark",
                transparent: false,
                watermarkNote: "去掉右下角蓝色鱼骨水印",
                template,
            }).success,
        ).toBe(true);

        expect(
            masterV2InputSchema.safeParse({
                imageUrl: sourceUrl,
                operation: "extract_from_photo",
                transparent: true,
            }).success,
        ).toBe(true);

        expect(
            masterV2InputSchema.safeParse({
                imageUrl: sourceUrl,
                operation: "transparent_only",
                transparent: false,
            }).success,
        ).toBe(false);

        expect(
            masterV2InputSchema.safeParse({
                imageUrl: sourceUrl,
                operation: "remove_watermark",
                transparent: false,
                watermarkNote: "a".repeat(201),
            }).success,
        ).toBe(false);

        expect(
            masterV2InputSchema.safeParse({
                imageUrl: sourceUrl,
                operation: "remove_watermark",
                transparent: false,
                extraField: true,
            }).success,
        ).toBe(false);
    });

    it("按 transparent 要求执行确定性 PNG 与透明/可见像素校验", async () => {
        expect(
            await checkV2Printable(await opaquePng(512, 512), false),
        ).toEqual({ passed: true });
        expect(
            await checkV2Printable(await transparentCirclePng(512), true),
        ).toEqual({ passed: true });
        expect(
            (await checkV2Printable(await opaquePng(512, 512), true)).passed,
        ).toBe(false);
        expect(
            (await checkV2Printable(await emptyTransparentPng(512), true))
                .passed,
        ).toBe(false);
        expect(
            (await checkV2Printable(await opaquePng(128, 128), false)).passed,
        ).toBe(false);
    });

    it("按操作类型组装提示词，实拍提取保留全部伴生/点缀/装饰元素，去水印透传说明且支持无 template 复用", () => {
        const removePrompt = buildV2EditInstruction({
            operation: "remove_watermark",
            transparent: false,
            watermarkNote: "斜向平铺白色英文水印",
            spec,
        });
        expect(removePrompt).toContain("去水印修复");
        expect(removePrompt).toContain("斜向平铺白色英文水印");
        expect(removePrompt).toContain("background=opaque");

        const extractPrompt = buildV2EditInstruction({
            operation: "extract_from_photo",
            transparent: true,
            spec,
        });
        expect(extractPrompt).toContain("实拍提取平面印花");
        expect(extractPrompt).toContain("background=transparent");
        expect(extractPrompt).toContain(spec.defaults.subject);
        for (const element of spec.elements) {
            if (
                element.category === "accent" ||
                element.category === "decoration" ||
                element.category === "edge"
            ) {
                expect(extractPrompt).toContain(element.id);
                expect(extractPrompt).toContain(element.description);
            }
        }

        const standaloneTransparent = buildV2EditInstruction({
            operation: "transparent_only",
            transparent: true,
        });
        expect(standaloneTransparent).toContain("仅生成透明底");
        expect(standaloneTransparent).toContain("background=transparent");
    });
});

describe("template-master/v2 单次执行与失败语义", () => {
    it.each([
        {
            name: "remove_watermark（不透明，含 watermarkNote）",
            input: {
                imageUrl: sourceUrl,
                operation: "remove_watermark" as const,
                transparent: false,
                watermarkNote: "去掉斜向平铺水印",
                template,
            },
            expectedBackground: "opaque" as const,
            buildOutput: () => opaquePng(1024, 1024),
        },
        {
            name: "extract_from_photo（透明底，带 template）",
            input: {
                imageUrl: sourceUrl,
                operation: "extract_from_photo" as const,
                transparent: true,
                template,
            },
            expectedBackground: "transparent" as const,
            buildOutput: () => transparentCirclePng(1024),
        },
        {
            name: "transparent_only（透明底，无 template，MCP 独立复用）",
            input: {
                imageUrl: sourceUrl,
                operation: "transparent_only" as const,
                transparent: true,
            },
            expectedBackground: "transparent" as const,
            buildOutput: () => transparentCirclePng(1024),
        },
    ])(
        "单次调用 gpt-image-2.6-sunburst（medium）并上传交付：$name",
        async ({ input, expectedBackground, buildOutput }) => {
            const sourcePng = await opaquePng(600, 600);
            const editedPng = await buildOutput();
            const editCalls: MasterEditRequest[] = [];
            const uploadCalls: Buffer[] = [];
            const capability: TemplateMasterCapability = {
                edit: async (request) => {
                    editCalls.push(request);
                    return editedPng;
                },
                upload: async (bytes) => {
                    uploadCalls.push(bytes);
                    return makeUploaded(bytes);
                },
            };

            const registration = createTemplateMasterV2Registration({
                capability,
                loadSource: async () => sourcePng,
            });
            const accepted = registration.accept(input);
            expect(accepted.accepted).toBe(true);
            if (!accepted.accepted) return;

            const result = await createProcessAttemptRunner().run({
                runId: "run-v2-ok",
                registration,
                acceptedInput: accepted.acceptedInput,
            });

            expect(result.status).toBe("succeeded");
            if (result.status !== "succeeded") return;
            expect(editCalls).toHaveLength(1);
            expect(uploadCalls).toHaveLength(1);
            expect(editCalls[0]).toMatchObject({
                model: templateMasterV2ImageModel,
                quality: "medium",
                background: expectedBackground,
                size: "1024x1024",
                idempotencyKey: "run-v2-ok-master-v2-1",
            });
            expect(masterV2OutputSchema.parse(result.output)).toEqual({
                preparedImage: makeUploaded(editedPng),
                master: {
                    operation: input.operation,
                    transparent: input.transparent,
                    modelName: templateMasterV2ImageModel,
                    checks: { printable: { passed: true } },
                },
            });
        },
    );

    it("改图明确拒绝返回 DEPENDENCY_FAILURE 且不上传", async () => {
        const upload = vi.fn();
        const registration = createTemplateMasterV2Registration({
            capability: {
                edit: async () => {
                    throw new MasterCapabilityError("rejected");
                },
                upload,
            },
            loadSource: async () => opaquePng(512, 512),
        });
        const accepted = registration.accept({
            imageUrl: sourceUrl,
            operation: "remove_watermark",
            transparent: false,
        });
        expect(accepted.accepted).toBe(true);
        if (!accepted.accepted) return;

        const result = await createProcessAttemptRunner().run({
            runId: "run-v2-rejected",
            registration,
            acceptedInput: accepted.acceptedInput,
        });
        expect(result).toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE" },
        });
        expect(upload).not.toHaveBeenCalled();
    });

    it("改图已派发但结果未知返回 DEPENDENCY_FAILURE_AFTER_COMMIT，单次不重试", async () => {
        const edit = vi.fn(async () => {
            throw new MasterCapabilityError("unknown");
        });
        const upload = vi.fn();
        const registration = createTemplateMasterV2Registration({
            capability: { edit, upload },
            loadSource: async () => opaquePng(512, 512),
        });
        const accepted = registration.accept({
            imageUrl: sourceUrl,
            operation: "extract_from_photo",
            transparent: false,
        });
        expect(accepted.accepted).toBe(true);
        if (!accepted.accepted) return;

        const result = await createProcessAttemptRunner().run({
            runId: "run-v2-unknown",
            registration,
            acceptedInput: accepted.acceptedInput,
        });
        expect(result).toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE_AFTER_COMMIT" },
        });
        expect(edit).toHaveBeenCalledTimes(1);
        expect(upload).not.toHaveBeenCalled();
    });

    it("要求透明底但模型产出纯不透明图时返回 MASTER_NOT_ACCEPTED 且不上传", async () => {
        const upload = vi.fn();
        const registration = createTemplateMasterV2Registration({
            capability: {
                edit: async () => opaquePng(1024, 1024),
                upload,
            },
            loadSource: async () => opaquePng(512, 512),
        });
        const accepted = registration.accept({
            imageUrl: sourceUrl,
            operation: "transparent_only",
            transparent: true,
        });
        expect(accepted.accepted).toBe(true);
        if (!accepted.accepted) return;

        const result = await createProcessAttemptRunner().run({
            runId: "run-v2-opaque",
            registration,
            acceptedInput: accepted.acceptedInput,
        });
        expect(result).toMatchObject({
            status: "failed",
            error: { code: "MASTER_NOT_ACCEPTED" },
        });
        expect(upload).not.toHaveBeenCalled();
    });

    it("改图成功后上传失败返回 DEPENDENCY_FAILURE_AFTER_COMMIT", async () => {
        const registration = createTemplateMasterV2Registration({
            capability: {
                edit: async () => opaquePng(1024, 1024),
                upload: async () => {
                    throw new MasterCapabilityError("upload");
                },
            },
            loadSource: async () => opaquePng(512, 512),
        });
        const accepted = registration.accept({
            imageUrl: sourceUrl,
            operation: "remove_watermark",
            transparent: false,
        });
        expect(accepted.accepted).toBe(true);
        if (!accepted.accepted) return;

        const result = await createProcessAttemptRunner().run({
            runId: "run-v2-upload-fail",
            registration,
            acceptedInput: accepted.acceptedInput,
        });
        expect(result).toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE_AFTER_COMMIT" },
        });
    });

    it("经 HttpTemplateMasterCapability 与内部 Business API 端到端透传 model、quality、background 并提供 OpenAPI 切片", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pipipi-master-v2-"));
        tempDirs.push(dir);
        const receivedEdits: unknown[] = [];
        const outputPng = await transparentCirclePng(1024);
        const businessApi: CrtBusinessApi = await startCrtBusinessApi({
            directory: dir,
            imageClient: {
                edit: async () => {
                    throw new Error("unused");
                },
            },
            templateEditor: {
                edit: async (request) => {
                    receivedEdits.push({
                        model: request.model,
                        quality: request.quality,
                        background: request.background,
                        size: request.size,
                        idempotencyKey: request.idempotencyKey,
                    });
                    return outputPng;
                },
            },
            templateStorage: {
                provider: "test",
                upload: async ({ objectKey }: { objectKey: string }) => ({
                    url: `https://assets.memebuy.cn/${objectKey}`,
                    urlAccess: "public",
                }),
            } as never,
        });
        closers.push(businessApi.close);

        const capability = new HttpTemplateMasterCapability(businessApi.url);
        const edited = await capability.edit({
            image: await opaquePng(512, 512),
            prompt: "extract artwork",
            size: "1024x1024",
            model: templateMasterV2ImageModel,
            quality: "medium",
            background: "transparent",
            idempotencyKey: "http-v2-1",
            signal: new AbortController().signal,
        });
        expect(edited.equals(outputPng)).toBe(true);
        expect(receivedEdits).toEqual([
            {
                model: templateMasterV2ImageModel,
                quality: "medium",
                background: "transparent",
                size: "1024x1024",
                idempotencyKey: "http-v2-1",
            },
        ]);

        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: businessApi.url,
        });
        const application: ProcessingApplication = constructed.application;
        closers.push(application.close);
        const { url } = await application.listen();

        const slice = await fetch(
            `${url}/openapi/processes/template-master/v2.json`,
        );
        expect(slice.status).toBe(200);
        const body = (await slice.json()) as {
            process: string;
            version: string;
            timeoutMs: number;
        };
        expect(body.process).toBe("template-master");
        expect(body.version).toBe("v2");
        expect(body.timeoutMs).toBe(templateMasterV2TimeoutMs);
    });
});
