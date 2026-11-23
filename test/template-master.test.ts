/** 母版分档、色键、确定性校验、模型校验比较与重试升档状态机的单元测试，全部使用测试替身。 */
import { readFileSync } from "node:fs";
import {
    type CreateAgentSessionResult,
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
    createCostLedger,
    withCostLedger,
} from "../src/process-runtime/cost.js";
import { draftSchema } from "../src/processes/template-from-image/design-spec/contract.js";
import { MasterCapabilityError } from "../src/processes/template-master/capability.js";
import {
    checkPalette,
    checkPrintable,
    checkSimilarity,
    parseColor,
} from "../src/processes/template-master/checks.js";
import {
    masterInputSchema,
    masterOutputSchema,
} from "../src/processes/template-master/contract.js";
import {
    decodeRgba,
    keyOutEdgeBackground,
    renderLightMaster,
} from "../src/processes/template-master/light.js";
import { buildEditInstruction } from "../src/processes/template-master/method.js";
import { createTemplateMasterRegistration } from "../src/processes/template-master/registration.js";
import { createTemplateMasterSkillRefs } from "../src/processes/template-master/skills.js";
import type { SourceCondition } from "../src/processes/template-master/tier.js";
import {
    attemptPlan,
    startingTier,
} from "../src/processes/template-master/tier.js";
import {
    evaluateVerification,
    type MasterVerificationRequest,
    PiMasterVerifier,
    type Verification,
} from "../src/processes/template-master/verifier.js";

const fixture = JSON.parse(
    readFileSync(
        new URL("./fixtures/template-v4-candidate.json", import.meta.url),
        "utf8",
    ),
);
const template = draftSchema.parse(fixture.draft);
const spec = template.runtimeSemantics.designSpec;
const condition: SourceCondition = {
    marks: [],
    carrier: "flat_artwork" as const,
    sharpness: "clear" as const,
    compressionArtifacts: false,
    notes: [],
};
const imageUrl = "https://assets.example.com/source.png";
const INK = { r: 0x20, g: 0x32, b: 0x4c };

type Paint = (x: number, y: number) => [number, number, number, number];
async function paint(width: number, height: number, fn: Paint) {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const [r, g, b, a] = fn(x, y);
            data.set([r, g, b, a], (y * width + x) * 4);
        }
    return sharp(data, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
}
const circle =
    (
        size: number,
        radius: number,
        background: [number, number, number, number],
    ): Paint =>
    (x, y) =>
        Math.hypot(x - size / 2, y - size / 2) <= radius
            ? [INK.r, INK.g, INK.b, 255]
            : background;
const white: [number, number, number, number] = [255, 255, 255, 255];
const clear: [number, number, number, number] = [0, 0, 0, 0];
const alphaAt = async (png: Buffer, x: number, y: number) => {
    const image = await decodeRgba(png);
    return image.data[(y * image.width + x) * 4 + 3] as number;
};

it.each([false, true])(
    "母版视觉校验声明严格输出合同并按需附原图（重档 %s）",
    async (heavy) => {
        const verdict = {
            texts: [],
            otherTexts: [],
            layout: { passed: true, offenders: [] },
            watermarkRemaining: false,
            ...(heavy ? { sourceFidelity: true } : {}),
        };
        const payloads: unknown[] = [];
        const verifier = new PiMasterVerifier({
            provider: "openai",
            model: "gpt-5.4",
            skills: createTemplateMasterSkillRefs(),
            modelRuntime: await ModelRuntime.create({
                modelsPath: null,
                refreshOnCreate: false,
            }),
            sessionFactory: async ({ resourceLoader }) => {
                expect(resourceLoader?.getSystemPrompt()).toMatch(
                    /弧线、圆环或波浪.*阅读起点和方向.*一整段.*对应.*id.*otherTexts/u,
                );
                const model = {
                    api: "openai-completions",
                    input: ["text", "image"],
                };
                const agent = {
                    onPayload: undefined as
                        | undefined
                        | ((
                              payload: unknown,
                              model: unknown,
                          ) => Promise<unknown>),
                };
                return {
                    session: {
                        model,
                        agent,
                        dispose() {},
                        prompt: async (
                            prompt: string,
                            options: { images: { data: string }[] },
                        ) => {
                            expect(options.images).toHaveLength(heavy ? 2 : 1);
                            expect(JSON.parse(prompt).defaultSubject).toBe(
                                heavy ? spec.defaults.subject : undefined,
                            );
                            if (heavy) {
                                const reference = await sharp(
                                    Buffer.from(
                                        options.images[1].data,
                                        "base64",
                                    ),
                                ).metadata();
                                expect(reference).toMatchObject({
                                    format: "webp",
                                    width: 16,
                                    height: 8,
                                });
                            }
                            payloads.push(await agent.onPayload?.({}, model));
                        },
                        messages: [
                            {
                                role: "assistant",
                                stopReason: "stop",
                                content: [
                                    {
                                        type: "text",
                                        text: JSON.stringify(verdict),
                                    },
                                ],
                            },
                        ],
                    },
                } as unknown as CreateAgentSessionResult;
            },
        });
        await expect(
            verifier.verify({
                image: await paint(8, 8, () => white),
                ...(heavy ? { source: await paint(16, 8, () => white) } : {}),
                spec,
                marks: [],
                transparent: false,
                signal: new AbortController().signal,
            }),
        ).resolves.toEqual(verdict);
        expect(payloads).toMatchObject([
            {
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        strict: true,
                        schema: {
                            additionalProperties: false,
                            required: Object.keys(verdict),
                            properties: {
                                texts: { items: { required: ["id", "read"] } },
                                layout: { required: ["passed", "offenders"] },
                            },
                        },
                    },
                },
            },
        ]);
    },
);

describe("合同", () => {
    const input = {
        imageUrl,
        template,
        condition,
        budget: { maxAttempts: 4, maxUsd: 1.5 },
    };
    it("接受完整输入并拒绝额外字段与越界预算", () => {
        expect(masterInputSchema.safeParse(input).success).toBe(true);
        expect(
            masterInputSchema.safeParse({ ...input, model: "x" }).success,
        ).toBe(false);
        expect(
            masterInputSchema.safeParse({
                ...input,
                budget: { maxAttempts: 0, maxUsd: 1 },
            }).success,
        ).toBe(false);
        expect(
            masterInputSchema.safeParse({
                ...input,
                budget: { maxAttempts: 11, maxUsd: 1 },
            }).success,
        ).toBe(false);
        expect(
            masterInputSchema.safeParse({
                ...input,
                budget: { maxAttempts: 1, maxUsd: 21 },
            }).success,
        ).toBe(false);
        const withExtras = masterInputSchema.safeParse({
            ...input,
            template: {
                ...template,
                cover: imageUrl,
                referenceImage: imageUrl,
                imageSize: "1024x1024",
                imageN: 1,
                kind: "PROMPT",
                promptTemplate: "display prompt",
                preprocessSteps: [],
                status: "DRAFT",
                metadata: {
                    tags: ["标签1"],
                    needsReview: true,
                    editablePrompt: true,
                    templateSource: "source-box",
                },
            },
        });
        expect(withExtras.success).toBe(true);
        if (withExtras.success && "template" in withExtras.data) {
            expect(withExtras.data.template).not.toHaveProperty("cover");
            expect(withExtras.data.template.metadata).not.toHaveProperty(
                "needsReview",
            );
        }
    });
    it("输出 Schema 严格", () => {
        const ok = {
            preparedImage: {
                url: `https://assets.memebuy.cn/gallery/template-images/${"a".repeat(64)}.png`,
                sha256: "a".repeat(64),
                width: 256,
                height: 256,
                contentType: "image/png",
            },
            master: {
                tier: "heavy",
                redrawn: true,
                attempts: [{ tier: "heavy", passed: true, failures: [] }],
                checks: {
                    text: { passed: true, expected: [], read: [] },
                    palette: { passed: true },
                    layout: { passed: true },
                    printable: { passed: true },
                    similarity: null,
                },
            },
        };
        expect(masterOutputSchema.safeParse(ok).success).toBe(true);
        expect(masterOutputSchema.safeParse({ ...ok, extra: 1 }).success).toBe(
            false,
        );
    });
});

describe("分档判据", () => {
    it("按载体、清晰度、标记与压缩痕迹推出起始档", () => {
        expect(startingTier(condition)).toBe("light");
        expect(
            startingTier({ ...condition, marks: [{ kind: "watermark" }] }),
        ).toBe("medium");
        expect(
            startingTier({ ...condition, sharpness: "slightly_blurry" }),
        ).toBe("medium");
        expect(startingTier({ ...condition, compressionArtifacts: true })).toBe(
            "medium",
        );
        expect(startingTier({ ...condition, carrier: "garment_photo" })).toBe(
            "heavy",
        );
        expect(startingTier({ ...condition, carrier: "scene_photo" })).toBe(
            "heavy",
        );
        expect(
            startingTier({ ...condition, sharpness: "severely_blurry" }),
        ).toBe("heavy");
    });
    it("轻档只试一次，生成档各三次", () => {
        expect(attemptPlan("light")).toEqual(["light"]);
        expect(attemptPlan("medium")).toHaveLength(6);
        expect(attemptPlan("heavy")).toEqual(["heavy", "heavy", "heavy"]);
    });
});

describe("四边连通色键", () => {
    it("去掉与边缘相连的底，保留被框线围住的同色区", async () => {
        const size = 300;
        const source = await paint(size, size, (x, y) => {
            const d = Math.hypot(x - 150, y - 150);
            if (d > 100 && d <= 120) return [INK.r, INK.g, INK.b, 255];
            return white;
        });
        const { png: keyed } = await renderLightMaster(source, "standalone");
        expect(await alphaAt(keyed, 2, 2)).toBe(0);
        expect(await alphaAt(keyed, 150, 150)).toBe(255);
        expect(await alphaAt(keyed, 150, 150 - 110)).toBe(255);
    });
    it("已有透明则保留，非单色底不处理，矩形贴片原样转 PNG", async () => {
        const transparent = await paint(300, 300, circle(300, 90, clear));
        const kept = await decodeRgba(
            (await renderLightMaster(transparent, "standalone")).png,
        );
        expect(kept.data[3]).toBe(0);
        const gradient = await paint(300, 300, (x) => [x % 256, 120, 40, 255]);
        const image = await decodeRgba(gradient);
        expect(keyOutEdgeBackground(image).removed).toBe(0);
        const { png: patch } = await renderLightMaster(
            await paint(300, 300, circle(300, 90, white)),
            "rect_patch",
        );
        expect(await alphaAt(patch, 2, 2)).toBe(255);
    });
});

describe("可印校验", () => {
    it("独立图形：居中且干净通过", async () => {
        expect(
            (
                await checkPrintable(
                    await paint(400, 400, circle(400, 120, clear)),
                    "standalone",
                )
            ).passed,
        ).toBe(true);
    });
    it("截断、整张矩形、缺透明通道、过小、光晕都不通过", async () => {
        expect(
            (
                await checkPrintable(
                    await paint(400, 400, circle(400, 260, clear)),
                    "standalone",
                )
            ).passed,
        ).toBe(false);
        expect(
            (
                await checkPrintable(
                    await paint(400, 400, () => [INK.r, INK.g, INK.b, 255]),
                    "standalone",
                )
            ).passed,
        ).toBe(false);
        expect(
            (
                await checkPrintable(
                    await sharp({
                        create: {
                            width: 400,
                            height: 400,
                            channels: 3,
                            background: white,
                        },
                    })
                        .png()
                        .toBuffer(),
                    "standalone",
                )
            ).passed,
        ).toBe(false);
        expect(
            (
                await checkPrintable(
                    await paint(100, 100, circle(100, 20, clear)),
                    "standalone",
                )
            ).passed,
        ).toBe(false);
        const halo = await paint(400, 400, (x, y) => {
            const d = Math.hypot(x - 200, y - 200);
            return d <= 60
                ? [INK.r, INK.g, INK.b, 255]
                : d <= 180
                  ? [INK.r, INK.g, INK.b, 90]
                  : clear;
        });
        const result = await checkPrintable(halo, "standalone");
        expect(result.passed).toBe(false);
        expect(result.detail).toContain("光晕");
    });
    it("矩形贴片与出血裁切须不透明", async () => {
        const opaque = await paint(400, 400, circle(400, 120, white));
        expect((await checkPrintable(opaque, "rect_patch")).passed).toBe(true);
        expect((await checkPrintable(opaque, "bleed_crop")).passed).toBe(true);
        expect(
            (
                await checkPrintable(
                    await paint(400, 400, circle(400, 120, clear)),
                    "rect_patch",
                )
            ).passed,
        ).toBe(false);
    });
});

describe("色板与相似度", () => {
    it("解析十六进制与 rgb()，颜色名不解析", () => {
        expect(parseColor("深藏青（#20324c）")).toEqual([0x20, 0x32, 0x4c]);
        expect(parseColor("#fff")).toEqual([255, 255, 255]);
        expect(parseColor("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
        expect(parseColor("深藏青")).toBeUndefined();
    });
    it("默认颜色出现在前景中才通过", async () => {
        expect(
            (
                await checkPalette(
                    await paint(400, 400, circle(400, 120, clear)),
                    spec,
                )
            ).passed,
        ).toBe(true);
        const other = await paint(400, 400, (x, y) =>
            Math.hypot(x - 200, y - 200) <= 120 ? [200, 30, 30, 255] : clear,
        );
        const result = await checkPalette(other, spec);
        expect(result.passed).toBe(false);
        expect(result.detail).toContain("headline_ink");
    });
    it("轻中档比相似度，重档不比", async () => {
        const source = await paint(400, 400, circle(400, 120, white));
        const { png: keyed } = await renderLightMaster(source, "standalone");
        expect(
            (await checkSimilarity(keyed, source, "light"))?.score,
        ).toBeGreaterThanOrEqual(0.95);
        const other = await paint(400, 400, (x) =>
            x < 200 ? [0, 0, 0, 255] : [255, 255, 255, 255],
        );
        expect((await checkSimilarity(other, source, "medium"))?.passed).toBe(
            false,
        );
        expect(await checkSimilarity(other, source, "heavy")).toBeNull();
    });
});

describe("模型校验比较", () => {
    const base: Verification = {
        texts: [{ id: "headline", read: "look  good" }],
        otherTexts: [],
        layout: { passed: true, offenders: [] },
        watermarkRemaining: false,
    };
    function compare(expected: string, read: string | null) {
        return evaluateVerification(
            {
                ...spec,
                defaults: { ...spec.defaults, texts: { headline: expected } },
            },
            [],
            { ...base, texts: read === null ? [] : [{ id: "headline", read }] },
        );
    }
    it.each([..."’‘‛＇`´"])("撇号 %s 等价于 ASCII 撇号", (apostrophe) => {
        const result = compare("I'm sweet", `I${apostrophe}m sweet`);
        expect(result.text.passed).toBe(true);
        expect(result.failures).toEqual([]);
    });
    it.each([..."‐‑‒–—－"])("连字符或破折号 %s 等价于 ASCII 连字符", (dash) => {
        expect(compare("A-B", `a${dash}b`).text.passed).toBe(true);
    });
    it("忽略排版等价的引号、全半角、大小写和空白差异", () => {
        expect(
            compare(
                '"Look good",印花(2)!?',
                "“ＬＯＯＫ　ｇｏｏｄ”，印花（２）！？",
            ).failures,
        ).toEqual([]);
        expect(compare('"Look good"', "＂Look good＂").failures).toEqual([]);
    });
    it.each([
        ["LOOK GOOD", null, "读取为空"],
        ["LOOK GOOD", "　 ", "读取为空"],
        ["LOOK GOOD", "LOOK GOD", "缺字"],
        ["LOOK GOOD", "LOOK GOOOD", "多字"],
        ["LOOK GOOD", "GOOD LOOK", "文字顺序不同"],
        ["LOOK GOOD", "LOOK GOOD!", "仅标点或空白差异"],
        ["花样2", "花樣3", "文字内容不同"],
        [
            "I'm sweet like peaches",
            "I’m sweet like strawberries",
            "文字内容不同",
        ],
    ])("把 %s 与 %s 的差异分类为 %s", (expected, read, reason) => {
        const result = compare(expected, read);
        expect(result.text.passed).toBe(false);
        expect(result.failures).toEqual([
            { check: "text", detail: `headline：${reason}` },
        ]);
    });
    it("清单外文字、残留水印、版面偏离分别产生失败项且不回显读到的文字", () => {
        const result = evaluateVerification(
            spec,
            [{ kind: "watermark", text: "WM" }],
            {
                ...base,
                otherTexts: ["SECRET", " ", "ALSO SECRET"],
                watermarkRemaining: true,
                layout: { passed: false, offenders: ["headline"] },
            },
        );
        expect(result.failures.map((f) => f.check)).toEqual([
            "text",
            "text",
            "layout",
        ]);
        expect(JSON.stringify(result.failures)).not.toContain("SECRET");
        expect(result.failures[0]?.detail).toBe("出现清单外文字 2 处");
        expect(result.text.read).toContain("SECRET");
    });
});

it.each(["medium", "heavy"] as const)("%s 生成提示保留弯曲文字排布", (tier) => {
    const prompt = buildEditInstruction({
        tier,
        spec,
        form: "standalone",
        marks: [],
    });
    expect(prompt).toMatch(/弧线、圆环或波浪.*阅读起点和方向.*直线/u);
});

describe("重试、升档与预算", () => {
    const good = (size: string) => {
        const side = Number(size.split("x")[0]);
        return paint(side, side, circle(side, side * 0.29, white));
    };
    const okVerification: Verification = {
        texts: [{ id: "headline", read: "LOOK GOOD" }],
        otherTexts: [],
        layout: { passed: true, offenders: [] },
        watermarkRemaining: false,
        sourceFidelity: true,
    };
    async function run(options: {
        source?: Buffer;
        cond?: typeof condition;
        budget?: { maxAttempts: number; maxUsd: number };
        design?: typeof spec;
        edit?: (call: number, size: string) => Promise<Buffer>;
        verify?: (call: number) => Verification;
        spent?: () => number;
    }) {
        const source =
            options.source ?? (await paint(400, 400, circle(400, 116, white)));
        let editCalls = 0;
        let verifyCalls = 0;
        const edit = vi.fn(async (request: { size: string }) => {
            editCalls++;
            return (options.edit ?? ((_, size) => good(size)))(
                editCalls,
                request.size,
            );
        });
        const upload = vi.fn(async (_png: Buffer) => ({
            url: `https://assets.memebuy.cn/gallery/template-images/${"b".repeat(64)}.png`,
            sha256: "b".repeat(64),
            width: 1024,
            height: 1024,
            contentType: "image/png" as const,
        }));
        const verify = vi.fn(async (_request: MasterVerificationRequest) => {
            verifyCalls++;
            return (options.verify ?? (() => okVerification))(verifyCalls);
        });
        const registration = createTemplateMasterRegistration({
            capability: { edit, upload },
            verifier: { verify },
            loadSource: async () => source,
            spentUsd: options.spent ?? (() => 0),
        });
        const accepted = registration.accept({
            imageUrl,
            template: {
                ...template,
                runtimeSemantics: {
                    ...template.runtimeSemantics,
                    designSpec: options.design ?? spec,
                },
            },
            condition: options.cond ?? condition,
            budget: options.budget ?? { maxAttempts: 10, maxUsd: 5 },
        });
        if (!accepted.accepted) throw new Error("input rejected");
        const completion = await registration.run(accepted.acceptedInput, {
            runId: "run-1",
            signal: new AbortController().signal,
        });
        return { completion, edit, upload, verify, source };
    }
    const marked = {
        ...condition,
        marks: [{ kind: "watermark" as const, text: "WM" }],
    };

    it("轻档一次通过，沿用默认文字，零模型调用与费用", async () => {
        const ledger = createCostLedger();
        const { completion, edit, upload, verify } = await withCostLedger(
            ledger,
            () => run({}),
        );
        expect(verify).not.toHaveBeenCalled();
        expect(ledger.snapshot()).toEqual({
            usd: 0,
            provider: 0,
            estimate: 0,
            unknown: 0,
        });
        expect(completion.status).toBe("succeeded");
        if (completion.status !== "succeeded") return;
        const output = masterOutputSchema.parse(completion.output);
        expect(output.master.tier).toBe("light");
        expect(output.master.redrawn).toBe(false);
        expect(output.master.backgroundKept).toBeUndefined();
        expect(output.master.checks.text).toEqual({
            passed: true,
            expected: ["LOOK GOOD"],
            read: ["LOOK GOOD"],
        });
        expect(output.master.checks.layout.passed).toBe(true);
        expect(output.master.attempts).toEqual([
            {
                tier: "light",
                passed: true,
                failures: [],
                reason: "原图像素，未调用模型读字",
            },
        ]);
        expect(output.master.checks.similarity?.passed).toBe(true);
        expect(edit).not.toHaveBeenCalled();
        expect(upload).toHaveBeenCalledOnce();
    });
    it("轻档不按解析的默认颜色判失败，原图像素直接交付", async () => {
        const roles = spec.whole.colorRoles.map((role) => role.id);
        const design = {
            ...spec,
            defaults: {
                ...spec.defaults,
                colors: Object.fromEntries(roles.map((id) => [id, "#00ff00"])),
            },
        };
        const { completion, edit, verify } = await run({ design });
        expect(completion.status).toBe("succeeded");
        if (completion.status !== "succeeded") return;
        const output = masterOutputSchema.parse(completion.output);
        expect(output.master.tier).toBe("light");
        expect(output.master.attempts).toHaveLength(1);
        expect(output.master.attempts[0]?.passed).toBe(true);
        expect(edit).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
    });
    it.each(["四边渐变", "色键后图案贴边"])(
        "%s 时上传带底原图，一次通过",
        async (sample) => {
            const source = await paint(400, 400, (x, y) =>
                sample === "四边渐变"
                    ? circle(400, 116, [x % 256, 120, 40, 255])(x, y)
                    : x < 80 && y < 240
                      ? [INK.r, INK.g, INK.b, 255]
                      : white,
            );
            const { completion, upload, verify, edit } = await run({
                source,
                budget: { maxAttempts: 1, maxUsd: 1 },
            });
            expect(completion).toMatchObject({
                status: "succeeded",
                output: {
                    master: {
                        tier: "light",
                        backgroundKept: true,
                        attempts: [
                            { tier: "light", passed: true, failures: [] },
                        ],
                        checks: {
                            printable: { passed: false },
                            similarity: { passed: true, score: 1 },
                        },
                    },
                },
            });
            expect(upload).toHaveBeenCalledExactlyOnceWith(
                source,
                expect.any(AbortSignal),
            );
            expect(edit).not.toHaveBeenCalled();
            expect(verify).not.toHaveBeenCalled();
        },
    );
    it("原图尺寸不可印时失败，不升档", async () => {
        const { completion, edit, verify, upload } = await run({
            source: await paint(128, 128, circle(128, 40, white)),
        });
        expect(completion).toMatchObject({
            status: "failed",
            error: { code: "MASTER_NOT_ACCEPTED" },
        });
        expect(edit).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
    });
    it("水印从中档开始，模型读字失败后在中档重试", async () => {
        const { completion, edit, verify } = await run({
            cond: marked,
            verify: (call) =>
                call === 1
                    ? {
                          ...okVerification,
                          texts: [{ id: "headline", read: "LOOK GOD" }],
                      }
                    : okVerification,
        });
        expect(completion.status).toBe("succeeded");
        if (completion.status !== "succeeded") return;
        const output = masterOutputSchema.parse(completion.output);
        expect(output.master.tier).toBe("medium");
        expect(
            output.master.attempts.map((a) => `${a.tier}:${a.passed}`),
        ).toEqual(["medium:false", "medium:true"]);
        expect(output.master.attempts[0]?.failures).toEqual([
            { check: "text", detail: "headline：缺字" },
        ]);
        expect(edit).toHaveBeenCalledTimes(2);
        expect(verify).toHaveBeenCalledTimes(2);
    });
    it("确定性校验不过时不付模型校验费，重试提示含上次失败原因", async () => {
        const { completion, verify } = await run({
            cond: marked,
            edit: async (call, size) => {
                if (call === 1)
                    return paint(1024, 1024, (x) => [x % 256, 90, 90, 255]);
                return good(size);
            },
        });
        expect(completion.status).toBe("succeeded");
        expect(verify).toHaveBeenCalledOnce();
    });
    it("中档三次用尽升重档，重档通过且相似度为 null", async () => {
        const { completion, verify, source } = await run({
            cond: marked,
            verify: (call) =>
                call <= 3
                    ? { ...okVerification, watermarkRemaining: true }
                    : okVerification,
        });
        expect(completion.status).toBe("succeeded");
        if (completion.status !== "succeeded") return;
        const output = masterOutputSchema.parse(completion.output);
        expect(output.master.tier).toBe("heavy");
        expect(output.master.redrawn).toBe(true);
        expect(output.master.checks.similarity).toBeNull();
        expect(output.master.attempts).toHaveLength(4);
        expect(verify).toHaveBeenCalledTimes(4);
        expect(verify.mock.calls.map(([request]) => request.source)).toEqual([
            undefined,
            undefined,
            undefined,
            source,
        ]);
    });
    it.each(["文字", "主体"])(
        "直传模板默认%s与原图记录不一致时直接重绘，跳档不消耗预算",
        async (field) => {
            const design = structuredClone(spec);
            if (field === "主体") {
                design.defaults.subject = "一只灰色短毛兔";
            } else {
                const text = design.elements.find(
                    (element) => element.id === "headline",
                );
                if (!text) throw new Error("夹具缺少文字元素");
                text.instance = "CATCTOR.";
            }
            const { completion, edit, verify, source } = await run({
                design,
                cond: field === "主体" ? marked : condition,
                budget: { maxAttempts: 1, maxUsd: 5 },
            });
            expect(completion).toMatchObject({
                status: "succeeded",
                output: {
                    master: {
                        attempts: [
                            {
                                tier: "heavy",
                                passed: true,
                                failures: [],
                                reason: `默认${field}与原图记录不一致，跳过轻档和中档`,
                            },
                        ],
                    },
                },
            });
            expect(edit).toHaveBeenCalledOnce();
            expect(verify).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ source }),
            );
        },
    );
    it("直传文字排版等价且主体证据缺失时沿用原档位", async () => {
        const design = structuredClone(spec);
        for (const element of design.elements) {
            if (element.category === "text")
                element.instance = "Ｌｏｏｋ\ngood";
            if (element.category === "subject") {
                delete element.originalObject;
                delete element.instance;
            }
        }
        const { completion, edit } = await run({ design });
        expect(completion).toMatchObject({
            status: "succeeded",
            output: { master: { tier: "light" } },
        });
        expect(edit).not.toHaveBeenCalled();
    });
    it("重档保真失败用 similarity 记录并重试，只上传通过的母版", async () => {
        const { completion, verify, upload } = await run({
            cond: { ...condition, carrier: "garment_photo" },
            verify: (call) => ({ ...okVerification, sourceFidelity: call > 1 }),
        });
        expect(completion).toMatchObject({
            status: "succeeded",
            output: {
                master: {
                    attempts: [
                        {
                            tier: "heavy",
                            passed: false,
                            failures: [
                                {
                                    check: "similarity",
                                    detail: "重档母版未通过原图设计保真校验",
                                },
                            ],
                        },
                        { tier: "heavy", passed: true, failures: [] },
                    ],
                },
            },
        });
        expect(verify).toHaveBeenCalledTimes(2);
        expect(upload).toHaveBeenCalledOnce();
    });
    it("重档直接起步，三次用尽返回 MASTER_NOT_ACCEPTED", async () => {
        const { completion, edit, upload } = await run({
            cond: { ...condition, carrier: "garment_photo" },
            verify: () => ({ ...okVerification, sourceFidelity: false }),
        });
        expect(edit).toHaveBeenCalledTimes(3);
        expect(upload).not.toHaveBeenCalled();
        expect(completion).toMatchObject({
            status: "failed",
            error: { code: "MASTER_NOT_ACCEPTED" },
        });
    });
    it("生成被拒计入次数并带 generation 失败项", async () => {
        let calls = 0;
        const { completion } = await run({
            cond: { ...condition, carrier: "scene_photo" },
            budget: { maxAttempts: 2, maxUsd: 5 },
            edit: async (_, size) => {
                if (++calls === 1) throw new MasterCapabilityError("rejected");
                return good(size);
            },
        });
        expect(completion.status).toBe("succeeded");
        if (completion.status !== "succeeded") return;
        expect(
            masterOutputSchema.parse(completion.output).master.attempts[0]
                ?.failures[0]?.check,
        ).toBe("generation");
    });
    it("次数用尽返回 MASTER_BUDGET_EXHAUSTED，且不超过 maxAttempts", async () => {
        const { completion, edit } = await run({
            cond: marked,
            budget: { maxAttempts: 2, maxUsd: 5 },
            verify: (call) => ({
                ...okVerification,
                texts: [
                    { id: "headline", read: call === 1 ? "" : "GOOD LOOK" },
                ],
                otherTexts: call === 1 ? [] : ["SECRET"],
            }),
        });
        expect(edit).toHaveBeenCalledTimes(2);
        expect(completion).toMatchObject({
            status: "failed",
            error: {
                code: "MASTER_BUDGET_EXHAUSTED",
                publicMessage:
                    "母版预算已用尽（次数上限 2、金额上限 5 USD）：已尝试 medium×2，最后失败项：text（headline：文字顺序不同、出现清单外文字 1 处）",
            },
        });
    });
    it("已知费用达到上限即停止，不再改图", async () => {
        const { completion, edit } = await run({
            cond: marked,
            budget: { maxAttempts: 10, maxUsd: 0.5 },
            spent: () => 0.5,
        });
        expect(edit).not.toHaveBeenCalled();
        expect(completion).toMatchObject({
            status: "failed",
            error: {
                code: "MASTER_BUDGET_EXHAUSTED",
                publicMessage:
                    "母版预算已用尽（次数上限 10、金额上限 0.5 USD）：已尝试 无",
            },
        });
    });
    it("逐元素保留差异，公开消息过长时省略后续完整条目", async () => {
        const headline = spec.elements.find(({ id }) => id === "headline");
        if (!headline) throw new Error("fixture headline missing");
        const firstId = "a".repeat(80);
        const ids = [firstId, "b".repeat(80), "c".repeat(80)];
        const design = {
            ...spec,
            elements: [
                ...spec.elements,
                ...ids.map((id) => ({ ...headline, id })),
            ],
            defaults: {
                ...spec.defaults,
                texts: {
                    ...spec.defaults.texts,
                    ...Object.fromEntries(ids.map((id) => [id, "EXPECTED"])),
                },
            },
        };
        const verify = () => ({
            ...okVerification,
            texts: [...okVerification.texts, { id: firstId, read: "SECRET" }],
        });
        expect(evaluateVerification(design, [], verify()).failures).toEqual([
            { check: "text", detail: `${ids[0]}：文字内容不同` },
            { check: "text", detail: `${ids[1]}：读取为空` },
            { check: "text", detail: `${ids[2]}：读取为空` },
        ]);
        const { completion } = await run({
            design,
            cond: marked,
            budget: { maxAttempts: 1, maxUsd: 5 },
            verify,
        });
        if (completion.status !== "failed") throw new Error("expected failure");
        expect(completion.error.publicMessage.length).toBeLessThanOrEqual(200);
        expect(completion.error.publicMessage).toBe(
            `母版预算已用尽（次数上限 1、金额上限 5 USD）：已尝试 medium×1，最后失败项：text（${ids[0]}：文字内容不同…）`,
        );
    });
    it("通过后上传失败：已付费改图为 AFTER_COMMIT，轻档为 DEPENDENCY_FAILURE", async () => {
        const source = await paint(400, 400, circle(400, 116, white));
        const registration = createTemplateMasterRegistration({
            capability: {
                edit: async () => good("1024x1024"),
                upload: async () => {
                    throw new MasterCapabilityError("upload");
                },
            },
            verifier: { verify: async () => okVerification },
            loadSource: async () => source,
            spentUsd: () => 0,
        });
        const accepted = registration.accept({
            imageUrl,
            template,
            condition,
            budget: { maxAttempts: 3, maxUsd: 5 },
        });
        if (!accepted.accepted) throw new Error("rejected");
        const done = await registration.run(accepted.acceptedInput, {
            runId: "r",
            signal: new AbortController().signal,
        });
        expect(done).toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE" },
        });
    });
});
