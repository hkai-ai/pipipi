import {
    type CreateAgentSessionResult,
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Ajv2020 } from "ajv/dist/2020.js";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { PiStructuredAgentOptions } from "../src/agent-runtime/structured.js";
import { PiTemplateAgent } from "../src/processes/template-from-image/agent.pi.js";
import { compileTemplateResult } from "../src/processes/template-from-image/contract.js";
import {
    applyTemplateInspection,
    planDigest,
} from "../src/processes/template-from-image/inspection.js";
import {
    materializeTemplatePlan,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import {
    candidateDigest,
    reviewIssues,
} from "../src/processes/template-from-image/quality.js";
import { createTemplateSkillRefs } from "../src/processes/template-from-image/skills.js";
import { candidate, reviewFor } from "./fixtures/template-candidate.js";
import { compactInspection, compactPlan } from "./fixtures/template-compact.js";

const image = {
    data: (
        await sharp({
            create: { width: 64, height: 64, channels: 3, background: "white" },
        })
            .png()
            .toBuffer()
    ).toString("base64"),
    mimeType: "image/png" as const,
    width: 64,
    height: 64,
};
function inspection(plan = toTemplatePlan(candidate())) {
    const { reviewedDraftSha256: _digest, ...review } = reviewFor(
        materializeTemplatePlan(plan),
    );
    return {
        reviewedPlanSha256: planDigest(plan),
        changes: [] as { path: string; value: unknown }[],
        review,
    };
}
async function agentFor(
    texts: string[],
    supportsImage = true,
    api = "openai-completions",
) {
    const prompts: string[] = [];
    const payloads: unknown[] = [];
    const prompt = vi.fn(async (text: string, _options?: unknown) => {
        prompts.push(text);
    });
    const dispose = vi.fn();
    let count = 0;
    const sessionFactory = vi.fn(
        async (
            options: Parameters<
                NonNullable<PiStructuredAgentOptions["sessionFactory"]>
            >[0],
        ) => {
            expect(options.settingsManager?.getRetryEnabled()).toBe(false);
            expect(
                options.settingsManager?.getProviderRetrySettings().maxRetries,
            ).toBe(0);
            expect(options.settingsManager?.getCompactionEnabled()).toBe(false);
            expect(options).toMatchObject({
                noTools: "all",
                tools: [],
                customTools: [],
                thinkingLevel: "medium",
            });
            expect(options.resourceLoader?.getSystemPrompt()).toContain(
                "团队纪念照的专业图标",
            );
            const model = {
                id: "test-vision",
                api,
                input: supportsImage ? ["text", "image"] : ["text"],
            };
            const control = {
                onPayload: undefined as
                    | undefined
                    | ((payload: unknown, model: unknown) => Promise<unknown>),
            };
            return {
                session: {
                    model,
                    agent: control,
                    prompt: async (text: string, options?: unknown) => {
                        payloads.push(
                            await control.onPayload?.({ messages: [] }, model),
                        );
                        await prompt(text, options);
                    },
                    abort: async () => {},
                    dispose,
                    messages: [
                        {
                            role: "assistant",
                            stopReason: "stop",
                            content: [{ type: "text", text: texts[count++] }],
                        },
                    ],
                },
            } as unknown as CreateAgentSessionResult;
        },
    );
    const agent = new PiTemplateAgent({
        skills: createTemplateSkillRefs(),
        modelRuntime: await ModelRuntime.create({
            modelsPath: null,
            refreshOnCreate: false,
        }),
        sessionFactory,
    });
    return { agent, prompt, prompts, payloads, dispose, sessionFactory };
}

describe("模板生成与独立视觉复核", () => {
    it("编译和独立复核保留原图并提供完整内容观察，不切断文字行", async () => {
        const data = (
            await sharp(
                Buffer.from(
                    '<svg width="512" height="512"><rect width="512" height="512" fill="white"/><rect x="32" y="192" width="448" height="128" fill="red"/><rect x="160" y="340" width="192" height="20" fill="black"/></svg>',
                ),
            )
                .png()
                .toBuffer()
        ).toString("base64");
        const detailImage = { ...image, data, width: 512, height: 512 };
        const plan = toTemplatePlan(candidate());
        const service = await agentFor([
            JSON.stringify(compactPlan(plan)),
            JSON.stringify(compactInspection(inspection(plan))),
        ]);
        const signal = new AbortController().signal;
        await service.agent.compile({ image: detailImage, signal });
        await service.agent.review({
            image: detailImage,
            plan,
            issues: [],
            signal,
        });
        for (const call of service.prompt.mock.calls) {
            const attachments = (call[1] as { images: { data: string }[] })
                .images;
            expect(attachments).toHaveLength(2);
            expect(attachments[0].data).toBe(data);
            expect(call[0]).toContain("唯一原图总览");
            const input = JSON.parse(call[0].slice(call[0].indexOf("\n") + 1));
            expect(input.pixelContours).toMatchObject({
                width: 512,
                height: 512,
            });
            expect(input.pixelContours.bands).toHaveLength(2);
            expect(input.pixelContours.bands[0].samples[0].top).toBe(192);
            expect(input.imageViews).not.toContain('"samples"');
            expect(call[0]).toContain("不分割整行文字或组件组");
            expect(
                await sharp(
                    Buffer.from(attachments[1].data, "base64"),
                ).metadata(),
            ).toMatchObject({ width: 448, height: 168 });
        }
        expect(detailImage.data).toBe(data);
    });
    it("复核补丁受请求级 Schema 约束，首轮仍沿用 JSON 模式", async () => {
        const plan = toTemplatePlan(candidate());
        const service = await agentFor([
            JSON.stringify(compactPlan(plan)),
            JSON.stringify(compactInspection(inspection(plan))),
        ]);
        const signal = new AbortController().signal;
        await service.agent.compile({ image, signal });
        await service.agent.review({ image, plan, issues: [], signal });
        expect(service.payloads[0]).toMatchObject({
            response_format: { type: "json_object" },
        });
        expect(service.payloads[1]).toMatchObject({
            response_format: {
                type: "json_schema",
                json_schema: {
                    strict: true,
                },
            },
        });
        const payload = service.payloads[1] as {
            response_format: { json_schema: { schema: object } };
        };
        expect(
            JSON.stringify(payload.response_format.json_schema.schema),
        ).not.toContain('"propertyNames"');
        const validate = new Ajv2020().compile(
            payload.response_format.json_schema.schema,
        );
        const response = compactInspection(inspection(plan));
        expect(validate(response)).toBe(true);
        expect(
            validate({ ...response, changes: [["/draft/title", "标题"]] }),
        ).toBe(false);
        expect(
            validate({ ...response, changes: [{ path: "/draft/title" }] }),
        ).toBe(false);
        expect(
            validate({
                ...response,
                changes: [{ path: "/draft/missing", valueJson: "null" }],
            }),
        ).toBe(false);
        expect(
            validate({ ...response, reviewedPlanSha256: "0".repeat(64) }),
        ).toBe(false);
        const invalidEvidence = structuredClone(response);
        invalidEvidence.review.checks.slotScopeMinimal.evidence[0].path =
            "/analysis/targetScopes/main_subject";
        expect(validate(invalidEvidence)).toBe(false);
        invalidEvidence.review.checks.slotScopeMinimal.evidence[0].path =
            "/analysis/editableCandidates/0/selectionReason";
        expect(validate(invalidEvidence)).toBe(false);
        expect(
            validate({
                ...response,
                changes: [{ path: "/draft/title", valueJson: '"新标题"' }],
            }),
        ).toBe(true);
    });
    it("Responses 协议也传递严格 Schema，不支持的协议在请求前拒绝", async () => {
        const plan = toTemplatePlan(candidate());
        const response = JSON.stringify(compactInspection(inspection(plan)));
        const request = {
            image,
            plan,
            issues: [],
            signal: new AbortController().signal,
        };
        const responses = await agentFor([response], true, "openai-responses");
        await responses.agent.review(request);
        expect(responses.payloads[0]).toMatchObject({
            text: { format: { type: "json_schema", strict: true } },
        });
        const unsupported = await agentFor(
            [response],
            true,
            "anthropic-messages",
        );
        await expect(unsupported.agent.review(request)).rejects.toThrow(
            "不支持 JSON Schema",
        );
        expect(unsupported.prompt).not.toHaveBeenCalled();
        expect(unsupported.dispose).toHaveBeenCalledOnce();
    });
    it.each(["正常 JSON", "末尾多余括号", "Markdown 包裹"])(
        "%s：两次独立会话均传入真实附件",
        async (format) => {
            const plan = toTemplatePlan(candidate());
            const raw = JSON.stringify(compactPlan(plan));
            const text =
                format === "末尾多余括号"
                    ? `${raw}}`
                    : format === "Markdown 包裹"
                      ? `\`\`\`json\n${raw}\n\`\`\``
                      : raw;
            const { agent, prompt, sessionFactory, dispose, prompts } =
                await agentFor([
                    text,
                    JSON.stringify(compactInspection(inspection(plan))),
                ]);
            const signal = new AbortController().signal;
            const generated = await agent.compile({ image, signal });
            expect(generated).toEqual(plan);
            expect(generated).not.toHaveProperty("review");
            const result = await agent.review({
                image,
                plan: generated,
                issues: [],
                signal,
            });
            expect(
                compileTemplateResult(
                    result,
                    "https://example.com/image.png",
                    image,
                ).kind,
            ).toBe("PROMPT");
            expect(sessionFactory).toHaveBeenCalledTimes(2);
            expect(dispose).toHaveBeenCalledTimes(2);
            expect(prompt).toHaveBeenNthCalledWith(
                1,
                expect.any(String),
                expect.objectContaining({
                    images: [
                        {
                            type: "image",
                            data: image.data,
                            mimeType: image.mimeType,
                        },
                    ],
                }),
            );
            expect(prompt).toHaveBeenNthCalledWith(
                2,
                expect.any(String),
                expect.objectContaining({
                    images: [
                        {
                            type: "image",
                            data: image.data,
                            mimeType: image.mimeType,
                        },
                    ],
                }),
            );
            expect(prompts[1]).toContain(planDigest(plan));
            const reviewInput = JSON.parse(
                prompts[1].slice(prompts[1].indexOf("\n") + 1),
            );
            expect(reviewInput.repairContext.slotConstraints[0]).toMatchObject({
                slotId: "subject",
                requiresFeatureAuthority: true,
                suggestions: plan.draft.inputSchema.slots[0].text.suggestions,
            });
            expect(prompts[1]).not.toContain("previousReview");
        },
    );
    it("模型没有图片能力时不提交请求", async () => {
        const { agent, prompt } = await agentFor(["{}"], false);
        await expect(
            agent.compile({ image, signal: new AbortController().signal }),
        ).rejects.toThrow();
        expect(prompt).not.toHaveBeenCalled();
    });
    it("独立复核直接修补遗漏，未涉及内容保持不变，不请求第三次复核", async () => {
        const plan = toTemplatePlan(candidate());
        const response = inspection(plan);
        response.changes = [
            { path: "/draft/description", value: "拥抱你的新朋友" },
        ];
        const { agent, sessionFactory } = await agentFor([
            JSON.stringify(compactInspection(response)),
        ]);
        const result = (await agent.review({
            image,
            plan,
            issues: ["补充发现文案"],
            signal: new AbortController().signal,
        })) as ReturnType<typeof applyTemplateInspection>;
        expect(result.draft.description).toBe("拥抱你的新朋友");
        expect(result.draft.inputSchema).toEqual(plan.draft.inputSchema);
        expect(result.draft.runtimeSemantics).toEqual(
            plan.analysis.semanticModel.runtimeSemantics,
        );
        expect(plan.draft.description).not.toBe(result.draft.description);
        expect(reviewIssues(result, result.review)).toEqual([]);
        expect(sessionFactory).toHaveBeenCalledOnce();
    });
    it("拒绝旧输入摘要、漏项报告及越界补丁", () => {
        const plan = toTemplatePlan(candidate());
        const value = inspection(plan);
        expect(() =>
            applyTemplateInspection(plan, {
                ...value,
                reviewedPlanSha256: "0".repeat(64),
            }),
        ).toThrow("模板候选未通过校验");
        expect(() =>
            applyTemplateInspection(plan, {
                ...value,
                review: { checks: {}, issues: [] },
            }),
        ).toThrow();
        expect(() =>
            applyTemplateInspection(plan, {
                ...value,
                changes: [{ path: "/draft/missing", value: "x" }],
            }),
        ).toThrow();
    });
    it("复核失败、错误引用与补丁后报告摘要篡改均拦截", () => {
        const plan = toTemplatePlan(candidate());
        const value = inspection(plan);
        value.review.checks.tagsValid.passed = false;
        let result = applyTemplateInspection(plan, value);
        expect(() =>
            compileTemplateResult(result, "https://example.com/a.png", image),
        ).toThrow();
        value.review.checks.tagsValid.passed = true;
        value.review.checks.tagsValid.evidence[0].path = "/draft/missing";
        result = applyTemplateInspection(plan, value);
        expect(reviewIssues(result, result.review).join()).toContain(
            "引用不存在",
        );
        result.draft.description = "篡改";
        expect(candidateDigest(result)).not.toBe(
            result.review.reviewedDraftSha256,
        );
    });
});
