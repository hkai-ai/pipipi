import {
    type CreateAgentSessionResult,
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";
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
    data: "cG5n",
    mimeType: "image/png" as const,
    width: 800,
    height: 600,
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
async function agentFor(texts: string[], supportsImage = true) {
    const prompts: string[] = [];
    const prompt = vi.fn(async (text: string) => {
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
            return {
                session: {
                    model: {
                        id: "test-vision",
                        input: supportsImage ? ["text", "image"] : ["text"],
                    },
                    prompt,
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
    return { agent, prompt, prompts, dispose, sessionFactory };
}

describe("模板生成与独立视觉复核", () => {
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
            plan.draft.runtimeSemantics,
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
