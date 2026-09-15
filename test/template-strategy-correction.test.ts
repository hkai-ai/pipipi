import {
    type CreateAgentSessionResult,
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, vi } from "vitest";
import { createProcessAttemptRunner } from "../src/process-runtime/index.js";
import { PiTemplateStrategyAgent } from "../src/processes/template-from-source/agent.pi.js";
import {
    applyStrategyCorrection,
    strategyCorrectionSchema,
} from "../src/processes/template-from-source/correction.js";
import { templatePlanProduction } from "../src/processes/template-from-source/production.js";
import { createTemplatePlanRegistration } from "../src/processes/template-from-source/registration.js";
import {
    parseReplacementStrategy,
    type StrategyIssue,
    StrategyValidationError,
} from "../src/processes/template-from-source/strategy.js";
import { imageStrategy } from "./fixtures/template-image-strategy.js";

const issues: StrategyIssue[] = [
    { code: "canvas_exclusions", fields: ["targetCanvas"] },
];
const changes = [
    {
        field: "targetCanvas",
        valueJson: JSON.stringify(imageStrategy().targetCanvas),
    },
];

it("修正期间取消请求，即使模型随后返回也不会保存方案", async () => {
    const controller = new AbortController();
    const candidate = imageStrategy();
    candidate.targetCanvas.excludedScopes = [];
    const savePlan = vi.fn();
    const repair = vi.fn(async () => {
        controller.abort();
        return { changes };
    });
    const registration = createTemplatePlanRegistration({
        agent: { plan: async () => candidate, repair },
        preparation: { savePlan, render: vi.fn(), finalize: vi.fn() },
        loadImage: async () => ({
            data: "cG5n",
            mimeType: "image/png",
            width: 1024,
            height: 1024,
        }),
    });
    const accepted = registration.accept({
        imageUrl: "https://images.example.com/source.png",
    });
    if (!accepted.accepted) throw new Error("夹具输入无效");
    expect(registration.timeoutMs).toBe(240_000);
    const result = await createProcessAttemptRunner().run({
        runId: "cancel-plan",
        registration,
        acceptedInput: accepted.acceptedInput,
        signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.status).toBe("failed");
    expect(repair).toHaveBeenCalledTimes(1);
    expect(savePlan).not.toHaveBeenCalled();
});

it("修正保留所有未涉及字段，拒绝越界、重复字段及错误 JSON", () => {
    const candidate = imageStrategy();
    candidate.targetCanvas.excludedScopes = [];
    const before = structuredClone(candidate);
    expect(applyStrategyCorrection(candidate, issues, { changes })).toEqual(
        imageStrategy(),
    );
    expect(candidate).toEqual(before);
    for (const patch of [
        { changes: [{ field: "__proto__", valueJson: "{}" }] },
        { changes: [{ field: "replacementValue", valueJson: '"新的身份"' }] },
        { changes: [...changes, ...changes] },
        { changes: [{ field: "targetCanvas", valueJson: "not-json" }] },
        { changes: [{ field: "targetCanvas", valueJson: "{}" }] },
    ])
        expect(() =>
            applyStrategyCorrection(candidate, issues, patch),
        ).toThrow();
});

it("校验汇总所有冲突，只返回规则和固定字段，不包含候选与未知键", () => {
    const candidate = imageStrategy();
    candidate.selectedIdentityFingerprint = candidate.sourceIdentityFingerprint;
    candidate.operations[0].targetComponentIds = ["PRIVATE-COMPONENT"];
    candidate.targetCanvas.excludedScopes = [];
    try {
        parseReplacementStrategy(candidate);
        expect.fail("必须拒绝不完整策略");
    } catch (error) {
        expect(error).toBeInstanceOf(StrategyValidationError);
        const diagnostic = (error as StrategyValidationError).issues;
        expect(diagnostic.map((issue) => issue.code)).toEqual([
            "different_identity",
            "operation_coverage",
            "canvas_exclusions",
        ]);
        expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE-");
    }
    try {
        parseReplacementStrategy({
            ...imageStrategy(),
            "PRIVATE-KEY": "PRIVATE-VALUE",
        });
        expect.fail("必须拒绝未知字段");
    } catch (error) {
        expect(
            JSON.stringify((error as StrategyValidationError).issues),
        ).not.toContain("PRIVATE-");
    }
});

it("真实 Agent 修正请求使用严格字段 Schema、原图和无 Tool 会话", async () => {
    const image = {
        data: "cG5n",
        mimeType: "image/png" as const,
        width: 1024,
        height: 1024,
    };
    const payloads: unknown[] = [];
    const prompts: unknown[] = [];
    const dispose = vi.fn();
    const agent = new PiTemplateStrategyAgent({
        skills: templatePlanProduction.installedSkills({}),
        modelRuntime: await ModelRuntime.create({
            modelsPath: null,
            refreshOnCreate: false,
        }),
        sessionFactory: async (options) => {
            expect(options).toMatchObject({
                noTools: "all",
                tools: [],
                customTools: [],
            });
            const control = {
                onPayload: undefined as
                    | undefined
                    | ((payload: unknown, model: unknown) => Promise<unknown>),
            };
            const model = {
                id: "test-vision",
                api: "openai-completions",
                input: ["text", "image"],
            };
            return {
                session: {
                    agent: control,
                    model,
                    prompt: async (text: string, input: unknown) => {
                        prompts.push({ text, input });
                        payloads.push(
                            await control.onPayload?.({ messages: [] }, model),
                        );
                    },
                    abort: async () => {},
                    dispose,
                    messages: [
                        {
                            role: "assistant",
                            stopReason: "stop",
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({ changes }),
                                },
                            ],
                        },
                    ],
                },
            } as unknown as CreateAgentSessionResult;
        },
    });
    expect(
        await agent.repair(
            image,
            imageStrategy(),
            issues,
            new AbortController().signal,
            "保留构图",
        ),
    ).toEqual({ changes });
    expect(prompts[0]).toMatchObject({
        input: { images: [{ type: "image", data: image.data }] },
    });
    expect(payloads[0]).toMatchObject({
        response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    const payload = payloads[0] as {
        response_format: { json_schema: { schema: object } };
    };
    const validate = new Ajv2020().compile(
        payload.response_format.json_schema.schema,
    );
    expect(validate({ changes })).toBe(true);
    expect(
        validate({
            changes: [{ field: "replacementValue", valueJson: '"越界"' }],
        }),
    ).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(
        strategyCorrectionSchema(issues).safeParse({ changes }).success,
    ).toBe(true);
});
