/** 商品做同款（product-remix/v1）输入输出契约、尺寸映射、双模式分档、质检重试、预算熔断与 Skill 校验单元测试。 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { AgentExecutionFailure } from "../src/agent-runtime/failure.js";
import { createSkillSet } from "../src/agent-runtime/skills.js";
import {
    evaluateRemixVerification,
    type ProductRemixAgent,
    type RemixPlan,
    type RemixVerification,
} from "../src/processes/product-remix/agent.js";
import { PiProductRemixAgent } from "../src/processes/product-remix/agent.pi.js";
import {
    type ProductRemixCapability,
    ProductRemixCapabilityError,
} from "../src/processes/product-remix/capability.js";
import {
    isProductRemixImageUrl,
    parseImageSize,
    productRemixInputSchema,
    productRemixOutputSchema,
    selectRemixImageSize,
} from "../src/processes/product-remix/contract.js";
import {
    createProductRemixRegistration,
    productRemixTimeoutMs,
} from "../src/processes/product-remix/registration.js";
import { createProductRemixSkillRefs } from "../src/processes/product-remix/skills.js";

const sourceImageUrl = "https://assets.example.com/gallery/original-print.png";
const referenceImageUrl =
    "https://private.example.com/user-uploads/dog.jpg?Expires=1800000000&Signature=abc123";

async function pngBuffer(width: number, height: number, background = "#fff") {
    return sharp({
        create: { width, height, channels: 3, background },
    })
        .png()
        .toBuffer();
}

function makePlan(overrides: Partial<RemixPlan> = {}): RemixPlan {
    return {
        tier: "light",
        rationale: "仅替换背景配色与文字，保持主体构图不变",
        editPrompt:
            "Keep the central illustration intact, change text to HAPPY BIRTHDAY, use clean blue and white palette on a flat background.",
        expectedTexts: ["HAPPY BIRTHDAY"],
        forbiddenTexts: ["OLD TEXT"],
        keepOriginalStyle: true,
        ...overrides,
    };
}

function makeVerification(
    overrides: Partial<RemixVerification> = {},
): RemixVerification {
    return {
        intentFollowed: true,
        textAccurate: true,
        noMockup: true,
        notCropped: true,
        issues: [],
        ...overrides,
    };
}

describe("契约与 URL 红线校验", () => {
    const validBase = {
        sourceImageUrl,
        userText: "把图案里的文字改成 HAPPY BIRTHDAY，配色换成蓝白",
        budget: { maxAttempts: 3, maxUsd: 1 },
    };

    it("接受合法单图与双图输入，并正确裁剪空白", () => {
        const single = productRemixInputSchema.safeParse(validBase);
        expect(single.success).toBe(true);

        const dual = productRemixInputSchema.safeParse({
            ...validBase,
            referenceImageUrl,
            imageSize: "896x1152",
            userText: "  把主体换成图 2 里的狗狗，保留原图插画风格  ",
        });
        expect(dual.success).toBe(true);
        if (dual.success) {
            expect(dual.data.userText).toBe(
                "把主体换成图 2 里的狗狗，保留原图插画风格",
            );
        }
    });

    it.each([
        ["额外未知字段", { ...validBase, extraField: "nope" }],
        [
            "非 HTTPS 协议",
            { ...validBase, sourceImageUrl: "http://assets.example.com/a.png" },
        ],
        [
            "显式非标准端口",
            {
                ...validBase,
                sourceImageUrl: "https://assets.example.com:8443/a.png",
            },
        ],
        [
            "显式 443 端口",
            {
                ...validBase,
                sourceImageUrl: "https://assets.example.com:443/a.png",
            },
        ],
        [
            "包含凭证",
            {
                ...validBase,
                sourceImageUrl: "https://user:pass@assets.example.com/a.png",
            },
        ],
        [
            "包含 hash 锚点",
            {
                ...validBase,
                sourceImageUrl: "https://assets.example.com/a.png#top",
            },
        ],
        [
            "包含末尾空 #",
            {
                ...validBase,
                sourceImageUrl: "https://assets.example.com/a.png#",
            },
        ],
        [
            "localhost 主机名",
            { ...validBase, sourceImageUrl: "https://localhost/a.png" },
        ],
        [
            "IPv4 地址",
            { ...validBase, sourceImageUrl: "https://8.8.8.8/a.png" },
        ],
        [
            "IPv6 地址",
            { ...validBase, sourceImageUrl: "https://[2001:db8::1]/a.png" },
        ],
        [
            "含 x-oss-process 查询参数",
            {
                ...validBase,
                sourceImageUrl:
                    "https://assets.example.com/a.png?x-oss-process=image/resize,w_200",
            },
        ],
        [
            "参考图含大写 X-OSS-PROCESS",
            {
                ...validBase,
                referenceImageUrl:
                    "https://assets.example.com/b.png?X-OSS-PROCESS=image/format,png",
            },
        ],
        ["空 userText", { ...validBase, userText: "   " }],
        ["超长 userText", { ...validBase, userText: "a".repeat(2001) }],
        ["非法 imageSize", { ...validBase, imageSize: "wide" }],
        ["过小 imageSize", { ...validBase, imageSize: "32x32" }],
        [
            "budget.maxAttempts = 0",
            { ...validBase, budget: { maxAttempts: 0, maxUsd: 1 } },
        ],
        [
            "budget.maxAttempts > 10",
            { ...validBase, budget: { maxAttempts: 11, maxUsd: 1 } },
        ],
        [
            "budget.maxAttempts 小数",
            { ...validBase, budget: { maxAttempts: 1.5, maxUsd: 1 } },
        ],
        [
            "budget.maxUsd <= 0",
            { ...validBase, budget: { maxAttempts: 3, maxUsd: 0 } },
        ],
        [
            "budget.maxUsd 负数",
            { ...validBase, budget: { maxAttempts: 3, maxUsd: -0.5 } },
        ],
        [
            "budget.maxUsd > 20",
            { ...validBase, budget: { maxAttempts: 3, maxUsd: 20.01 } },
        ],
        [
            "同时传入 referenceImageUrl 与 referenceImageUrls",
            {
                ...validBase,
                referenceImageUrl,
                referenceImageUrls: [referenceImageUrl],
            },
        ],
    ])("拒绝非法输入：%s", (_label, candidate) => {
        expect(productRemixInputSchema.safeParse(candidate).success).toBe(
            false,
        );
    });

    it("校验 output Schema 与 URL 红线", () => {
        expect(isProductRemixImageUrl("https://cdn.example.com/out.png")).toBe(
            true,
        );
        expect(
            isProductRemixImageUrl(
                "https://cdn.example.com/out.png?Signature=abc&Expires=999",
            ),
        ).toBe(true);
        expect(
            isProductRemixImageUrl(
                "https://cdn.example.com/out.png?x-oss-process=image/resize,w_400",
            ),
        ).toBe(false);

        const validOutput = {
            image: {
                url: `https://assets.example.com/product-remix/${"a".repeat(64)}.png`,
                width: 896,
                height: 1152,
            },
            modelName: "gpt-image-2.5-flare",
            resolvedTier: "medium",
        };
        expect(productRemixOutputSchema.safeParse(validOutput).success).toBe(
            true,
        );
        expect(
            productRemixOutputSchema.safeParse({ ...validOutput, extra: 1 })
                .success,
        ).toBe(false);
    });

    it("尺寸解析与正典宽高比选择正确", () => {
        expect(parseImageSize("1024x1024")).toEqual({
            width: 1024,
            height: 1024,
        });
        expect(parseImageSize("896X1152")).toEqual({
            width: 896,
            height: 1152,
        });
        expect(parseImageSize("100x")).toBeUndefined();
        expect(selectRemixImageSize({ width: 896, height: 1152 })).toBe(
            "896x1152",
        );
        expect(selectRemixImageSize({ width: 1200, height: 1600 })).toBe(
            "896x1152",
        );
        expect(selectRemixImageSize({ width: 1600, height: 900 })).toBe(
            "1344x768",
        );
        expect(selectRemixImageSize({ width: 900, height: 1600 })).toBe(
            "768x1344",
        );
    });
});

describe("Process 执行闭环、重试与预算门禁", () => {
    it("设置 660 秒（600s~720s）硬超时", () => {
        expect(productRemixTimeoutMs).toBeGreaterThanOrEqual(600_000);
        expect(productRemixTimeoutMs).toBeLessThanOrEqual(720_000);
        expect(productRemixTimeoutMs).toBe(660_000);
    });

    it("仅原图 + 改字换色命中 light 档，单图编辑并遵守四条印花硬性守则", async () => {
        const sourcePng = await pngBuffer(900, 1600);
        const generatedPng = await pngBuffer(768, 1344, "#e0f2fe");
        const edit = vi.fn<ProductRemixCapability["edit"]>(async () => ({
            bytes: generatedPng,
            width: 768,
            height: 1344,
            modelName: "gpt-image-2.5-flare",
        }));
        const upload = vi.fn<ProductRemixCapability["upload"]>(async () => ({
            url: `https://assets.example.com/product-remix/${"c".repeat(64)}.png`,
            width: 768,
            height: 1344,
        }));
        const plan = vi.fn<ProductRemixAgent["plan"]>(async () => makePlan());
        const verify = vi.fn<ProductRemixAgent["verify"]>(async () =>
            makeVerification(),
        );

        const registration = createProductRemixRegistration({
            capability: { edit, upload },
            agent: { plan, verify },
            loadSource: async () => sourcePng,
            spentUsd: () => 0,
        });

        const accepted = registration.accept({
            sourceImageUrl,
            userText: "把图案里的文字改成 HAPPY BIRTHDAY，配色换成蓝白",
            budget: { maxAttempts: 3, maxUsd: 1 },
        });
        expect(accepted.accepted).toBe(true);
        if (!accepted.accepted) return;

        const result = await registration.run(accepted.acceptedInput, {
            runId: "run-light-1",
            signal: new AbortController().signal,
        });

        expect(result).toEqual({
            status: "succeeded",
            output: {
                image: {
                    url: `https://assets.example.com/product-remix/${"c".repeat(64)}.png`,
                    width: 768,
                    height: 1344,
                },
                modelName: "gpt-image-2.5-flare",
                resolvedTier: "light",
            },
        });
        expect(plan).toHaveBeenCalledOnce();
        expect(plan.mock.calls[0]?.[0].referenceViews).toHaveLength(0);
        expect(plan.mock.calls[0]?.[0].targetSize).toBe("768x1344");
        expect(edit).toHaveBeenCalledOnce();
        expect(edit.mock.calls[0]?.[0].images).toHaveLength(1);
        expect(edit.mock.calls[0]?.[0].size).toBe("768x1344");
        expect(edit.mock.calls[0]?.[0].prompt).toContain("只产平面印花图案");
        expect(edit.mock.calls[0]?.[0].prompt).toContain(
            "绝不能把用户指令原文",
        );
        expect(upload).toHaveBeenCalledOnce();
    });

    it("原图和九张参考图贯穿规划、编辑与质检，第十张被拒绝", async () => {
        const sourcePng = await pngBuffer(1024, 1024);
        const refPng = await pngBuffer(1200, 900, "#fda4af");
        const generatedPng = await pngBuffer(896, 1152);
        const edit = vi.fn<ProductRemixCapability["edit"]>(async () => ({
            bytes: generatedPng,
            width: 896,
            height: 1152,
            modelName: "gpt-image-2.5-flare",
        }));
        const upload = vi.fn<ProductRemixCapability["upload"]>(async () => ({
            url: `https://assets.example.com/product-remix/${"d".repeat(64)}.png`,
            width: 896,
            height: 1152,
        }));
        const plan = vi.fn<ProductRemixAgent["plan"]>(async () =>
            makePlan({
                tier: "heavy",
                rationale: "使用图 2 的柯基犬替换主体并重构插画构图",
                expectedTexts: [],
                forbiddenTexts: [],
            }),
        );
        const verify = vi.fn<ProductRemixAgent["verify"]>(async () =>
            makeVerification(),
        );

        const registration = createProductRemixRegistration({
            capability: { edit, upload },
            agent: { plan, verify },
            loadSource: async (url) =>
                url === sourceImageUrl ? sourcePng : refPng,
            spentUsd: () => 0,
        });

        const accepted = registration.accept({
            sourceImageUrl,
            referenceImageUrls: Array.from(
                { length: 9 },
                () => referenceImageUrl,
            ),
            userText: "把主体换成图 2 里的狗狗，保留原图插画风格",
            imageSize: "896x1152",
            budget: { maxAttempts: 3, maxUsd: 1 },
        });
        expect(
            registration.accept({
                sourceImageUrl,
                referenceImageUrls: Array.from(
                    { length: 10 },
                    () => referenceImageUrl,
                ),
                userText: "改图",
                budget: { maxAttempts: 3, maxUsd: 1 },
            }).accepted,
        ).toBe(false);
        expect(accepted.accepted).toBe(true);
        if (!accepted.accepted) return;

        const result = await registration.run(accepted.acceptedInput, {
            runId: "run-heavy-1",
            signal: new AbortController().signal,
        });

        expect(result).toMatchObject({
            status: "succeeded",
            output: {
                resolvedTier: "heavy",
                modelName: "gpt-image-2.5-flare",
                image: { width: 896, height: 1152 },
            },
        });
        expect(plan.mock.calls[0]?.[0].referenceViews).toHaveLength(9);
        expect(edit.mock.calls[0]?.[0].images).toHaveLength(10);
        expect(edit.mock.calls[0]?.[0].size).toBe("896x1152");
        expect(verify.mock.calls[0]?.[0].referenceViews).toHaveLength(9);
    });

    it("首轮质检不通过时将失败原因注入第 2 轮修正并成功", async () => {
        const sourcePng = await pngBuffer(1024, 1024);
        const generatedPng = await pngBuffer(1024, 1024);
        const edit = vi.fn<ProductRemixCapability["edit"]>(async () => ({
            bytes: generatedPng,
            width: 1024,
            height: 1024,
            modelName: "gpt-image-2.5-flare",
        }));
        const upload = vi.fn<ProductRemixCapability["upload"]>(async () => ({
            url: `https://assets.example.com/product-remix/${"e".repeat(64)}.png`,
            width: 1024,
            height: 1024,
        }));
        let verifyCall = 0;
        const verify = vi.fn<ProductRemixAgent["verify"]>(async () => {
            verifyCall += 1;
            return verifyCall === 1
                ? makeVerification({
                      noMockup: false,
                      textAccurate: false,
                      issues: ["画面出现了 T 恤领口和褶皱"],
                  })
                : makeVerification();
        });

        const registration = createProductRemixRegistration({
            capability: { edit, upload },
            agent: { plan: async () => makePlan({ tier: "medium" }), verify },
            loadSource: async () => sourcePng,
            spentUsd: () => 0,
        });
        const accepted = registration.accept({
            sourceImageUrl,
            userText: "改成夏日沙滩主题",
            budget: { maxAttempts: 3, maxUsd: 2 },
        });
        if (!accepted.accepted) throw new Error("rejected");

        const result = await registration.run(accepted.acceptedInput, {
            runId: "run-retry-1",
            signal: new AbortController().signal,
        });

        expect(result.status).toBe("succeeded");
        expect(edit).toHaveBeenCalledTimes(2);
        expect(verify).toHaveBeenCalledTimes(2);
        expect(upload).toHaveBeenCalledTimes(1);
        expect(edit.mock.calls[0]?.[0].idempotencyKey).toBe(
            "run-retry-1-remix-1",
        );
        expect(edit.mock.calls[1]?.[0].idempotencyKey).toBe(
            "run-retry-1-remix-2",
        );
        expect(edit.mock.calls[1]?.[0].prompt).toContain(
            "画面出现了 T 恤领口和褶皱",
        );
    });

    it("达到 maxAttempts 耗尽仍未通过质检时返回 AGENT_FAILURE 且绝不上传或回显原图", async () => {
        const sourcePng = await pngBuffer(1024, 1024);
        const generatedPng = await pngBuffer(1024, 1024);
        const edit = vi.fn<ProductRemixCapability["edit"]>(async () => ({
            bytes: generatedPng,
            width: 1024,
            height: 1024,
            modelName: "gpt-image-2.5-flare",
        }));
        const upload = vi.fn<ProductRemixCapability["upload"]>();
        const verify = vi.fn<ProductRemixAgent["verify"]>(async () =>
            makeVerification({
                notCropped: false,
                issues: ["文字贴边裁切"],
            }),
        );

        const registration = createProductRemixRegistration({
            capability: { edit, upload },
            agent: { plan: async () => makePlan(), verify },
            loadSource: async () => sourcePng,
            spentUsd: () => 0,
        });
        const accepted = registration.accept({
            sourceImageUrl,
            referenceImageUrl,
            userText: "重绘主体",
            budget: { maxAttempts: 2, maxUsd: 5 },
        });
        if (!accepted.accepted) throw new Error("rejected");

        const result = await registration.run(accepted.acceptedInput, {
            runId: "run-exhaust-1",
            signal: new AbortController().signal,
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "AGENT_FAILURE" },
        });
        expect(edit).toHaveBeenCalledTimes(2);
        expect(upload).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(sourceImageUrl);
        expect(JSON.stringify(result)).not.toContain(referenceImageUrl);
    });

    it("达到 maxUsd 预算上限时熔断，不发起下一轮生图或质检", async () => {
        const sourcePng = await pngBuffer(1024, 1024);
        const generatedPng = await pngBuffer(1024, 1024);
        let spent = 0;
        const edit = vi.fn<ProductRemixCapability["edit"]>(async () => {
            spent += 0.6;
            return {
                bytes: generatedPng,
                width: 1024,
                height: 1024,
                modelName: "gpt-image-2.5-flare",
            };
        });
        const verify = vi.fn<ProductRemixAgent["verify"]>(async () => {
            spent += 0.5;
            return makeVerification({
                intentFollowed: false,
                issues: ["偏差"],
            });
        });
        const upload = vi.fn<ProductRemixCapability["upload"]>();

        const registration = createProductRemixRegistration({
            capability: { edit, upload },
            agent: {
                plan: async () => {
                    spent += 0.1;
                    return makePlan();
                },
                verify,
            },
            loadSource: async () => sourcePng,
            spentUsd: () => spent,
        });
        const accepted = registration.accept({
            sourceImageUrl,
            userText: "改图",
            budget: { maxAttempts: 5, maxUsd: 1 },
        });
        if (!accepted.accepted) throw new Error("rejected");

        const result = await registration.run(accepted.acceptedInput, {
            runId: "run-budget-1",
            signal: new AbortController().signal,
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "AGENT_FAILURE" },
        });
        expect(edit).toHaveBeenCalledOnce();
        expect(verify).toHaveBeenCalledOnce();
        expect(upload).not.toHaveBeenCalled();
    });

    it("当生图前尚未超支但生图后超出 maxUsd 时阻止无预算质检且不交付未验证图", async () => {
        const sourcePng = await pngBuffer(1024, 1024);
        const generatedPng = await pngBuffer(1024, 1024);
        let spent = 0.4;
        const edit = vi.fn<ProductRemixCapability["edit"]>(async () => {
            spent = 1.2;
            return {
                bytes: generatedPng,
                width: 1024,
                height: 1024,
                modelName: "gpt-image-2.5-flare",
            };
        });
        const verify = vi.fn<ProductRemixAgent["verify"]>();
        const upload = vi.fn<ProductRemixCapability["upload"]>();

        const registration = createProductRemixRegistration({
            capability: { edit, upload },
            agent: { plan: async () => makePlan(), verify },
            loadSource: async () => sourcePng,
            spentUsd: () => spent,
        });
        const accepted = registration.accept({
            sourceImageUrl,
            userText: "改图",
            budget: { maxAttempts: 3, maxUsd: 1 },
        });
        if (!accepted.accepted) throw new Error("rejected");

        const result = await registration.run(accepted.acceptedInput, {
            runId: "run-budget-qc-1",
            signal: new AbortController().signal,
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "AGENT_FAILURE" },
        });
        expect(edit).toHaveBeenCalledOnce();
        expect(verify).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
    });

    it("输入图无法读取或解码时返回 INVALID_INPUT 且零模型调用", async () => {
        const plan = vi.fn<ProductRemixAgent["plan"]>();
        const edit = vi.fn<ProductRemixCapability["edit"]>();
        const registration = createProductRemixRegistration({
            capability: {
                edit,
                upload: vi.fn(),
            },
            agent: { plan, verify: vi.fn() },
            loadSource: async () => Buffer.from("not-an-image"),
            spentUsd: () => 0,
        });
        const accepted = registration.accept({
            sourceImageUrl,
            userText: "换颜色",
            budget: { maxAttempts: 3, maxUsd: 1 },
        });
        if (!accepted.accepted) throw new Error("rejected");

        const result = await registration.run(accepted.acceptedInput, {
            runId: "run-bad-src",
            signal: new AbortController().signal,
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "INVALID_INPUT" },
        });
        expect(plan).not.toHaveBeenCalled();
        expect(edit).not.toHaveBeenCalled();
    });

    it("上游模型或图片服务异常返回 DEPENDENCY_FAILURE", async () => {
        const sourcePng = await pngBuffer(512, 512);
        const registrationPlanFail = createProductRemixRegistration({
            capability: { edit: vi.fn(), upload: vi.fn() },
            agent: {
                plan: async () => {
                    throw new AgentExecutionFailure({
                        stage: "request",
                        code: "provider_unavailable",
                    });
                },
                verify: vi.fn(),
            },
            loadSource: async () => sourcePng,
            spentUsd: () => 0,
        });
        const accepted = registrationPlanFail.accept({
            sourceImageUrl,
            userText: "改图",
            budget: { maxAttempts: 2, maxUsd: 1 },
        });
        if (!accepted.accepted) throw new Error("rejected");

        expect(
            await registrationPlanFail.run(accepted.acceptedInput, {
                runId: "r1",
                signal: new AbortController().signal,
            }),
        ).toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE" },
        });

        const registrationEditFail = createProductRemixRegistration({
            capability: {
                edit: async () => {
                    throw new ProductRemixCapabilityError("unknown");
                },
                upload: vi.fn(),
            },
            agent: { plan: async () => makePlan(), verify: vi.fn() },
            loadSource: async () => sourcePng,
            spentUsd: () => 0,
        });
        expect(
            await registrationEditFail.run(accepted.acceptedInput, {
                runId: "r2",
                signal: new AbortController().signal,
            }),
        ).toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE" },
        });

        const registrationRejectedAll = createProductRemixRegistration({
            capability: {
                edit: async () => {
                    throw new ProductRemixCapabilityError("rejected");
                },
                upload: vi.fn(),
            },
            agent: { plan: async () => makePlan(), verify: vi.fn() },
            loadSource: async () => sourcePng,
            spentUsd: () => 0,
        });
        expect(
            await registrationRejectedAll.run(accepted.acceptedInput, {
                runId: "r3",
                signal: new AbortController().signal,
            }),
        ).toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE" },
        });
    });

    it("若上传服务回显输入 URL 或返回不合规地址则返回 INVALID_OUTPUT", async () => {
        const sourcePng = await pngBuffer(512, 512);
        const generatedPng = await pngBuffer(1024, 1024);
        const registration = createProductRemixRegistration({
            capability: {
                edit: async () => ({
                    bytes: generatedPng,
                    width: 1024,
                    height: 1024,
                    modelName: "gpt-image-2.5-flare",
                }),
                upload: async () => ({
                    url: sourceImageUrl,
                    width: 1024,
                    height: 1024,
                }),
            },
            agent: {
                plan: async () => makePlan(),
                verify: async () => makeVerification(),
            },
            loadSource: async () => sourcePng,
            spentUsd: () => 0,
        });
        const accepted = registration.accept({
            sourceImageUrl,
            userText: "改图",
            budget: { maxAttempts: 2, maxUsd: 1 },
        });
        if (!accepted.accepted) throw new Error("rejected");

        expect(
            await registration.run(accepted.acceptedInput, {
                runId: "run-echo-url",
                signal: new AbortController().signal,
            }),
        ).toMatchObject({
            status: "failed",
            error: { code: "INVALID_OUTPUT" },
        });

        const secondReferenceUrl =
            "https://private.example.com/user-uploads/cat.jpg?Expires=1800000000&Signature=xyz789";
        const multiRefRegistration = createProductRemixRegistration({
            capability: {
                edit: async () => ({
                    bytes: generatedPng,
                    width: 1024,
                    height: 1024,
                    modelName: "gpt-image-2.5-flare",
                }),
                upload: async () => ({
                    url: secondReferenceUrl,
                    width: 1024,
                    height: 1024,
                }),
            },
            agent: {
                plan: async () => makePlan(),
                verify: async () => makeVerification(),
            },
            loadSource: async () => sourcePng,
            spentUsd: () => 0,
        });
        const acceptedMulti = multiRefRegistration.accept({
            sourceImageUrl,
            referenceImageUrls: [referenceImageUrl, secondReferenceUrl],
            userText: "改图",
            budget: { maxAttempts: 2, maxUsd: 1 },
        });
        if (!acceptedMulti.accepted) throw new Error("rejected");

        expect(
            await multiRefRegistration.run(acceptedMulti.acceptedInput, {
                runId: "run-echo-multi-ref",
                signal: new AbortController().signal,
            }),
        ).toMatchObject({
            status: "failed",
            error: { code: "INVALID_OUTPUT" },
        });
    });

    it("evaluateRemixVerification 为各项 false 标志补齐可执行中文修正建议", () => {
        expect(evaluateRemixVerification(makeVerification())).toEqual({
            passed: true,
            issues: [],
        });

        const failed = evaluateRemixVerification(
            makeVerification({
                intentFollowed: false,
                textAccurate: false,
                noMockup: false,
                notCropped: false,
                issues: [],
            }),
        );
        expect(failed.passed).toBe(false);
        expect(failed.issues).toHaveLength(4);
    });
});

describe("PiProductRemixAgent 会话与 Runtime Skill 校验", () => {
    it("在 JSON 语法错误后允许同轮重试一次并成功", async () => {
        const view = {
            data: (await pngBuffer(64, 64)).toString("base64"),
            mimeType: "image/webp" as const,
        };
        const replies = ["not-json", JSON.stringify(makePlan())];
        let calls = 0;
        const agent = new PiProductRemixAgent({
            skills: createProductRemixSkillRefs(),
            model: "gpt-5.4",
            provider: "openai",
            sessionFactory: async () => {
                const index = calls++;
                const messages: unknown[] = [];
                return {
                    session: {
                        model: {
                            id: "gpt-5.4",
                            api: "openai-completions",
                            input: ["text", "image"],
                        },
                        agent: { onPayload: undefined },
                        resourceLoader: { getSkills: () => ({ skills: [] }) },
                        subscribe: () => () => {},
                        prompt: async () => {
                            messages.push({
                                role: "assistant",
                                stopReason: "stop",
                                content: [
                                    {
                                        type: "text",
                                        text: replies[index] ?? "{}",
                                    },
                                ],
                            });
                        },
                        messages,
                        dispose: async () => {},
                    },
                } as unknown as CreateAgentSessionResult;
            },
        });

        const plan = await agent.plan({
            sourceView: view,
            referenceViews: [],
            userText: "改文字",
            targetSize: "1024x1024",
            signal: new AbortController().signal,
        });
        expect(plan.tier).toBe("light");
        expect(calls).toBe(2);
    });

    it("加载并校验 product-remix-method Runtime Skill 快照与镜像打包声明", () => {
        const refs = createProductRemixSkillRefs();
        const loaded = createSkillSet(refs, process.cwd()).load();
        expect(loaded.skills.map((item) => item.name)).toEqual([
            "product-remix-method",
        ]);
        expect(loaded.instructions).toContain("Product Remix Planner");
        expect(loaded.instructions).toContain("Product Remix QC");

        const ref = refs[0];
        if (!ref) throw new Error("missing ref");
        const content = readFileSync(`${ref.path}/SKILL.md`, "utf8");
        expect(createHash("sha256").update(content).digest("hex")).toBe(
            ref.sha256,
        );
        expect(readdirSync(ref.path).sort()).toEqual(["SKILL.md", "SOURCE.md"]);
        expect(readFileSync("Dockerfile", "utf8")).toContain(
            `COPY --chown=node:node ${ref.path} ./${ref.path}`,
        );
        expect(readFileSync(".dockerignore", "utf8")).toContain(
            `!${ref.path}/**`,
        );
        expect(readFileSync(".gitattributes", "utf8")).toContain(
            `${ref.path}/* text eol=lf`,
        );
    });
});
