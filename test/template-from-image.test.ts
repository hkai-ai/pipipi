import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAgentJson } from "../src/agent-runtime/pi.js";
import { createProcessingApplication } from "../src/api/application.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import type { TemplateAgent } from "../src/processes/template-from-image/agent.js";
import { expandTemplatePlan } from "../src/processes/template-from-image/compact.js";
import {
    compileTemplateResult,
    parseTemplateDraft,
    templateInputSchema,
    templateOutputSchema,
} from "../src/processes/template-from-image/contract.js";
import type { TemplateDiagnostic } from "../src/processes/template-from-image/diagnostics.js";
import {
    decodeTemplateImage,
    type TemplateImage,
    templateImageSize,
} from "../src/processes/template-from-image/image.js";
import {
    applyTemplateInspection,
    planDigest,
} from "../src/processes/template-from-image/inspection.js";
import {
    materializeTemplatePlan,
    TemplateProjectionError,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import { createTemplateRegistration } from "../src/processes/template-from-image/registration.js";
import type { TemplateDraft } from "../src/processes/template-from-image/types.js";
import { candidate, reviewFor } from "./fixtures/template-candidate.js";

const imageUrl =
    "https://images.example.com/reference.png?signature=private-test";
const image: TemplateImage = {
    data: "cG5n",
    mimeType: "image/png",
    width: 800,
    height: 600,
};

describe("模板合同", () => {
    it("图片槽漏掉文字模式时，修正信息必须明确缺失 text", () => {
        const value = candidate();
        const slot = value.draft.inputSchema.slots[0] as unknown as Record<
            string,
            unknown
        >;
        delete slot.text;
        try {
            compileTemplateResult(value, imageUrl, image);
            throw new Error("应当拒绝");
        } catch (error) {
            expect(error).toMatchObject({
                issues: expect.arrayContaining([
                    expect.stringContaining("required text"),
                ]),
            });
        }
    });
    it("绑定服务端草稿字段并通过原 Gallery Schema", () => {
        const template = compileTemplateResult(candidate(), imageUrl, image);
        expect(template).toMatchObject({
            status: "DRAFT",
            kind: "PROMPT",
            cover: imageUrl,
            referenceImage: imageUrl,
            imageN: 1,
            preprocessSteps: [],
            imageSize: "1152x896",
        });
        expect(templateOutputSchema.safeParse({ template }).success).toBe(true);
    });

    it.each([
        [
            "多余服务器字段",
            (draft: TemplateDraft) =>
                Object.assign(draft, { status: "PUBLISHED" }),
        ],
        [
            "失效目标引用",
            (draft: TemplateDraft) => {
                Object.values(
                    draft.runtimeSemantics.inputBindings,
                )[0].targetIds = ["missing"];
            },
        ],
        [
            "默认值泄漏到约束",
            (draft: TemplateDraft) => {
                draft.runtimeSemantics.visualContract.medium =
                    draft.inputSchema.slots[0].text?.defaultValue ?? "";
            },
        ],
        [
            "额外畸形占位符",
            (draft: TemplateDraft) => {
                draft.promptTemplate += " {{bad}}";
            },
        ],
        [
            "缺失占位符",
            (draft: TemplateDraft) => {
                draft.promptTemplate = "固定画面";
            },
        ],
        [
            "必填槽位",
            (draft: TemplateDraft) => {
                Object.assign(draft.inputSchema.slots[0], { required: true });
            },
        ],
        [
            "身份图片不私有",
            (draft: TemplateDraft) => {
                Object.assign(draft.inputSchema.slots[0].image ?? {}, {
                    private: false,
                });
            },
        ],
        [
            "推荐项不足",
            (draft: TemplateDraft) => {
                Object.assign(draft.inputSchema.slots[0].text ?? {}, {
                    suggestions: ["一项"],
                });
            },
        ],
    ] as const)("拒绝%s", (_name, mutate) => {
        const { draft } = candidate();
        mutate(draft);
        expect(() => parseTemplateDraft(draft)).toThrow();
    });

    it("复核必须完整且无未解决问题", () => {
        const value = candidate();
        value.review.issues.push("主角绑定冲突");
        expect(() => compileTemplateResult(value, imageUrl, image)).toThrow();
        expect(() =>
            compileTemplateResult({ draft: value.draft }, imageUrl, image),
        ).toThrow();
    });
    it("描述上限与模型合同一致，先拒绝不合法草稿", () => {
        const value = candidate();
        value.draft.description = "长".repeat(21);
        value.review.issues.push("仍有未解决的问题");
        try {
            compileTemplateResult(value, imageUrl, image);
            throw new Error("应当拒绝");
        } catch (error) {
            expect(error).toMatchObject({
                issues: expect.arrayContaining(["/description: maxLength"]),
            });
        }
    });

    it.each([
        "http://images.example.com/x.png",
        "https://127.0.0.1/x.png",
        "https://localhost/x.png",
    ])("拒绝非公网 HTTPS 输入 %s", (url) => {
        expect(templateInputSchema.safeParse({ imageUrl: url }).success).toBe(
            false,
        );
    });
});

describe("模板图片解码", () => {
    it("真实解码并限制视觉附件尺寸，保留原始宽高", async () => {
        const bytes = await sharp({
            create: {
                width: 2000,
                height: 1000,
                channels: 3,
                background: "white",
            },
        })
            .jpeg()
            .toBuffer();
        const decoded = await decodeTemplateImage(bytes);
        expect(decoded).toMatchObject({
            width: 2000,
            height: 1000,
            mimeType: "image/png",
        });
        expect(
            await sharp(Buffer.from(decoded.data, "base64")).metadata(),
        ).toMatchObject({ width: 1600, height: 800, format: "png" });
        expect(templateImageSize(decoded)).toBe("1344x768");
    });
    it("拒绝损坏、过小和非支持格式", async () => {
        await expect(
            decodeTemplateImage(Buffer.from("not an image")),
        ).rejects.toThrow();
        const tiny = await sharp({
            create: { width: 32, height: 32, channels: 3, background: "white" },
        })
            .png()
            .toBuffer();
        await expect(decodeTemplateImage(tiny)).rejects.toThrow("64");
        await expect(
            decodeTemplateImage(
                Buffer.from('<svg width="100" height="100"></svg>'),
            ),
        ).rejects.toThrow();
    });
});

const servers: ReturnType<typeof createProcessingApplication>[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(
    compile = vi.fn<TemplateAgent["compile"]>(async () =>
        toTemplatePlan(candidate()),
    ),
    review = vi.fn<TemplateAgent["review"]>(async ({ plan }) => {
        const value = materializeTemplatePlan(plan);
        return { ...value, review: reviewFor(value) };
    }),
    loadImage = vi.fn(async () => image),
    onDiagnostic?: (record: TemplateDiagnostic) => void,
) {
    const app = createProcessingApplication({
        executor: createProcessExecutor({
            registrations: [
                createTemplateRegistration({
                    agent: { compile, review },
                    loadImage,
                    onDiagnostic,
                }),
            ],
            runLogSink: () => {},
        }),
        http: { logSink: () => {} },
    });
    servers.push(app);
    const { url } = await app.listen();
    return {
        compile,
        review,
        loadImage,
        execute: (input: unknown = { imageUrl }) =>
            fetch(`${url}/execute`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    process: "template-from-image",
                    version: "v1",
                    input,
                }),
            }),
    };
}

describe("模板真实 HTTP 生成与独立复核", () => {
    it("两次结构失败留下关联诊断，不记录动态键、模型正文或校验消息", async () => {
        const diagnostics: TemplateDiagnostic[] = [];
        const compile = vi.fn<TemplateAgent["compile"]>(async () =>
            expandTemplatePlan({
                analysis: {
                    slotEvidence: {
                        "secret-user-content": {
                            featureAuthority: "private-body",
                        },
                    },
                },
                draft: {},
            }),
        );
        const service = await start(compile, undefined, undefined, (record) =>
            diagnostics.push(record),
        );
        const response = await service.execute();
        const result = await response.json();
        expect(response.status).toBe(502);
        expect(compile).toHaveBeenCalledTimes(2);
        expect(service.review).not.toHaveBeenCalled();
        expect(diagnostics).toMatchObject([
            {
                event: "template_diagnostic",
                runId: result.runId,
                stage: "compilation",
                attempt: 1,
                category: "structure",
            },
            {
                event: "template_diagnostic",
                runId: result.runId,
                stage: "correction",
                attempt: 2,
                category: "structure",
            },
        ]);
        expect(diagnostics[0].issues.length).toBeGreaterThan(0);
        expect(JSON.stringify(diagnostics)).not.toMatch(
            /secret-user-content|private-body|private-test|Invalid input|https:/,
        );
        expect(JSON.stringify(result)).not.toContain("template_diagnostic");
    });
    it("JSON 错误可区分，诊断 Sink 抛错也不阻止一次修正和独立复核", async () => {
        const compile = vi.fn<TemplateAgent["compile"]>(async () =>
            toTemplatePlan(candidate()),
        );
        compile.mockImplementationOnce(async () =>
            parseAgentJson([
                {
                    role: "assistant",
                    content: [{ type: "text", text: "private invalid JSON" }],
                },
            ]),
        );
        const diagnostic = vi.fn(() => {
            throw new Error("sink unavailable");
        });
        const service = await start(compile, undefined, undefined, diagnostic);
        expect((await service.execute()).status).toBe(200);
        expect(diagnostic).toHaveBeenCalledWith(
            expect.objectContaining({
                category: "json_syntax",
                stage: "compilation",
                issues: [],
            }),
        );
        expect(compile).toHaveBeenCalledTimes(2);
        expect(service.review).toHaveBeenCalledOnce();
    });
    it("合格首轮也必须独立复核，公开结果不含分析和报告", async () => {
        const service = await start();
        const response = await service.execute();
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.output.template).toMatchObject({
            kind: "PROMPT",
            status: "DRAFT",
        });
        expect(JSON.stringify(result.output)).not.toMatch(
            /semanticModel|reviewedPlanSha256|reviewedDraftSha256|repairContext/,
        );
        expect(service.compile).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ image }),
        );
        expect(service.review).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ image, issues: [] }),
        );
        expect(service.loadImage).toHaveBeenCalledOnce();
    });
    it("语义问题由第二次独立复核直接修补，不先重编译", async () => {
        const plan = toTemplatePlan(candidate());
        const correctPrompt = plan.draft.promptTemplate;
        plan.draft.promptTemplate = "missing placeholder";
        const compile = vi.fn<TemplateAgent["compile"]>(async () => plan);
        const review = vi.fn<TemplateAgent["review"]>(
            async ({ plan: previous }) => {
                const typed = previous as typeof plan;
                const { reviewedDraftSha256: _digest, ...checks } = reviewFor(
                    candidate(),
                );
                return applyTemplateInspection(typed, {
                    reviewedPlanSha256: planDigest(typed),
                    changes: [
                        { path: "/draft/promptTemplate", value: correctPrompt },
                    ],
                    review: checks,
                });
            },
        );
        const service = await start(compile, review);
        expect((await service.execute()).status).toBe(200);
        expect(compile).toHaveBeenCalledOnce();
        expect(review).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                plan,
                issues: expect.arrayContaining([
                    expect.stringMatching(/占位符|Prompt/),
                ]),
            }),
        );
    });
    it("引用错误不掩盖槽位、覆盖和权限问题，一次交给独立复核", async () => {
        const plan = toTemplatePlan(candidate());
        plan.analysis.spatialRelations[0].relationIndex = 63;
        plan.draft.inputSchema.slots[0].required = true;
        for (const axis of Object.values(plan.analysis.slotCoverageReview))
            axis.componentIds = [];
        const slotId = plan.draft.inputSchema.slots[0].id;
        const features = plan.analysis.slotEvidence[slotId].featureAuthority;
        expect(features).not.toBeNull();
        if (!features) throw new Error("fixture 必须包含特征权限");
        features.clothing.owner = "source";
        features.clothing.basis = "composition_dependency";
        const compile = vi.fn<TemplateAgent["compile"]>(async () => plan);
        const review = vi.fn<TemplateAgent["review"]>(async () => ({
            ...candidate(),
            review: reviewFor(candidate()),
        }));
        const service = await start(compile, review);
        expect((await service.execute()).status).toBe(200);
        expect(compile).toHaveBeenCalledOnce();
        expect(review).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                issues: expect.arrayContaining([
                    expect.stringContaining("必须可选"),
                    expect.stringContaining("组件遗漏八轴"),
                    expect.stringContaining("特征权限依据不匹配"),
                    expect.stringContaining("引用了不存在"),
                ]),
            }),
        );
    });
    it("失效引用仍交给唯一复核补丁修复，最终必须重新投影", async () => {
        const plan = toTemplatePlan(candidate());
        const index = plan.analysis.spatialRelations[0].relationIndex;
        plan.analysis.spatialRelations[0].relationIndex = 63;
        const review = vi.fn<TemplateAgent["review"]>(async () => {
            const { reviewedDraftSha256: _digest, ...checks } = reviewFor(
                candidate(),
            );
            return applyTemplateInspection(plan, {
                reviewedPlanSha256: planDigest(plan),
                changes: [
                    {
                        path: "/analysis/spatialRelations/0/relationIndex",
                        value: index,
                    },
                ],
                review: checks,
            });
        });
        const service = await start(
            vi.fn(async () => plan),
            review,
        );
        expect((await service.execute()).status).toBe(200);
        expect(service.compile).toHaveBeenCalledOnce();
        expect(review).toHaveBeenCalledOnce();
    });
    it.each(["JSON", "分析结构", "紧凑结构"])(
        "只有%s不可读时额外重编译一次，之后仍必须独立复核",
        async (kind) => {
            const compile = vi.fn<TemplateAgent["compile"]>(async () =>
                toTemplatePlan(candidate()),
            );
            if (kind === "JSON")
                compile.mockImplementationOnce(async () =>
                    parseAgentJson([
                        {
                            role: "assistant",
                            stopReason: "stop",
                            content: [{ type: "text", text: "not json" }],
                        },
                    ]),
                );
            else if (kind === "紧凑结构")
                compile.mockImplementationOnce(async () => {
                    throw new TemplateProjectionError(
                        { draft: {}, analysis: {} },
                        ["/analysis/editableCandidates/0/gates: 六项必须完整"],
                    );
                });
            else compile.mockResolvedValueOnce({ draft: {}, analysis: {} });
            const service = await start(compile);
            expect((await service.execute()).status).toBe(200);
            expect(compile).toHaveBeenCalledTimes(2);
            expect(service.review).toHaveBeenCalledOnce();
            expect(service.loadImage).toHaveBeenCalledOnce();
        },
    );
    it("两次结构都不可读则停止，不进入复核或追加第三次生成", async () => {
        const service = await start(
            vi.fn(async () => ({ draft: {}, analysis: {} })),
        );
        expect((await service.execute()).status).toBe(502);
        expect(service.compile).toHaveBeenCalledTimes(2);
        expect(service.review).not.toHaveBeenCalled();
    });
    it.each(["缺报告", "未解决问题", "错误路径", "错误摘要"])(
        "复核%s不放行，不再触发模型修正",
        async (kind) => {
            const value = candidate();
            const output: Record<string, unknown> = value;
            if (kind === "缺报告") delete output.review;
            if (kind === "未解决问题") value.review.issues.push("仍有身份冲突");
            if (kind === "错误路径")
                value.review.checks.tagsValid.evidence[0].path =
                    "/draft/missing";
            if (kind === "错误摘要")
                value.review.reviewedDraftSha256 = "0".repeat(64);
            const service = await start(
                undefined,
                vi.fn(async () => output),
            );
            expect((await service.execute()).status).toBe(502);
            expect(service.compile).toHaveBeenCalledOnce();
            expect(service.review).toHaveBeenCalledOnce();
        },
    );
    it("合法 null 可作为单主体无群组策略的复核证据", async () => {
        const value = candidate();
        value.review.checks.groupPolicyJustified.evidence = [
            {
                path: "/analysis/slotEvidence/subject/groupDecision",
                observation: "唯一主体的群组决议为 null，与 one_to_one 一致。",
            },
        ];
        const service = await start(
            undefined,
            vi.fn(async () => value),
        );
        expect((await service.execute()).status).toBe(200);
    });
    it.each(["compile", "review"] as const)(
        "%s 连接异常保留安全阶段，不重投或泄密",
        async (stage) => {
            const failure = new Error("wrapper", {
                cause: new Error(
                    "Connection error secret-token https://private.example",
                ),
            });
            const compile = vi.fn<TemplateAgent["compile"]>(async () =>
                toTemplatePlan(candidate()),
            );
            const review = vi.fn<TemplateAgent["review"]>(async () =>
                candidate(),
            );
            if (stage === "compile") compile.mockRejectedValue(failure);
            else review.mockRejectedValue(failure);
            const service = await start(compile, review);
            const result = await (await service.execute()).json();
            expect(result.error.message).toContain("模型连接中断");
            expect(JSON.stringify(result)).not.toMatch(
                /secret-token|private\.example/,
            );
            expect(result.error.message).toContain(
                stage === "compile" ? "模板编译" : "模板独立复核",
            );
            expect(compile).toHaveBeenCalledOnce();
            expect(review).toHaveBeenCalledTimes(stage === "compile" ? 0 : 1);
        },
    );
    it("调用方不能指定模型、Skill 或发布状态", async () => {
        const service = await start();
        expect(
            (await service.execute({ imageUrl, model: "override" })).status,
        ).toBe(400);
        expect(service.loadImage).not.toHaveBeenCalled();
        expect(service.compile).not.toHaveBeenCalled();
    });
    it("下载异常不调用模型，不回显原图地址", async () => {
        const service = await start(
            undefined,
            undefined,
            vi.fn(async () => {
                throw new Error(imageUrl);
            }),
        );
        const text = await (await service.execute()).text();
        expect(text).toContain("DEPENDENCY_FAILURE");
        expect(text).not.toContain("private-test");
        expect(service.compile).not.toHaveBeenCalled();
    });
});
