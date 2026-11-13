/** 经正式 HTTP 与流程接缝验证拆解候选、独立复核、旧版兼容及跨仓交接。 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { AgentExecutionFailure } from "../src/agent-runtime/failure.js";
import { AgentJsonSyntaxError } from "../src/agent-runtime/pi.js";
import { createProcessingApplication } from "../src/api/application.js";
import { createProcessAttemptRunner } from "../src/process-runtime/index.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import type { PrintDesignAgent } from "../src/processes/template-from-image/design-spec/agent.js";
import {
    candidateIssues,
    compileResult,
    PrintDesignContractError,
    readCandidate,
} from "../src/processes/template-from-image/design-spec/contract.js";
import { createPrintDesignRegistration } from "../src/processes/template-from-image/design-spec/registration.js";
import {
    applyReview,
    candidateDigest,
    reviewSchema,
} from "../src/processes/template-from-image/design-spec/review.js";
import { toTemplatePlan } from "../src/processes/template-from-image/projection.js";
import { createTemplateRegistration } from "../src/processes/template-from-image/registration.js";
import { createTemplateSourceRegistration } from "../src/processes/template-from-source/registration.js";
import { candidate, reviewFor } from "./fixtures/template-candidate.js";

const fixture = () =>
    readCandidate(
        JSON.parse(
            readFileSync(
                new URL(
                    "./fixtures/template-v4-candidate.json",
                    import.meta.url,
                ),
                "utf8",
            ),
        ),
    );
const image = {
    data: "cG5n",
    mimeType: "image/png" as const,
    width: 1024,
    height: 1024,
};
const imageUrl = `https://assets.memebuy.cn/gallery/template-images/${"c".repeat(64)}.png`;
function review(value = fixture()) {
    const evidence = [
        {
            path: "/draft/runtimeSemantics/designSpec",
            observation: "受控合成夹具按输入合同保留主体、配饰、收形与版面",
        },
    ];
    return {
        reviewedCandidateSha256: candidateDigest(value),
        changes: [] as { path: string; valueJson: string }[],
        checks: Object.fromEntries(
            [
                "imageFidelity",
                "layoutAndText",
                "printForm",
                "inputBindings",
                "defaultMigration",
                "sourceIsolation",
            ].map((key) => [key, { passed: true, evidence }]),
        ),
        issues: [] as { check: string; path: string; reason: string }[],
    };
}
const applications: ReturnType<typeof createProcessingApplication>[] = [];
afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
});
function dependencies() {
    return {
        loadImage: vi.fn(async () => image),
        agent: {
            compile: vi.fn<PrintDesignAgent["compile"]>(async () => fixture()),
            review: vi.fn<PrintDesignAgent["review"]>(async (request) =>
                review(request.candidate),
            ),
        },
    };
}
async function run(deps = dependencies()) {
    const registration = createPrintDesignRegistration(deps);
    const accepted = registration.accept({ imageUrl });
    if (!accepted.accepted) throw new Error("输入不合法");
    return createProcessAttemptRunner().run({
        runId: "fixed-template-v4",
        registration,
        acceptedInput: accepted.acceptedInput,
    });
}
it("源图批准入口 v3 复用同一成图，回包可交给 Memebuy；旧 v1 仍精确执行", async () => {
    const deps = dependencies();
    const compiler = createPrintDesignRegistration(deps);
    const old = candidate();
    const oldCompile = vi.fn(async () => toTemplatePlan(old));
    const legacy = createTemplateRegistration({
        loadImage: async () => image,
        agent: {
            compile: oldCompile,
            review: async () => ({ ...old, review: reviewFor(old) }),
        },
    });
    const preparation = {
        savePlan: vi.fn(),
        render: vi.fn(),
        finalize: vi.fn(async () => ({
            url: imageUrl,
            sha256: "c".repeat(64),
            width: 1024,
            height: 1024,
            contentType: "image/png" as const,
            note: "原始要求",
        })),
    };
    const source = createTemplateSourceRegistration({
        runtimeVersion: 4,
        compiler,
        attemptRunner: createProcessAttemptRunner(),
        preparation,
    });
    const app = createProcessingApplication({
        executor: createProcessExecutor({
            registrations: [compiler, source, legacy],
        }),
    });
    applications.push(app);
    const { url } = await app.listen({ host: "127.0.0.1", port: 0 });
    const approval = {
        productionId: "10000000-0000-4000-8000-000000000001",
        renderId: "20000000-0000-4000-8000-000000000001",
        objectSha256: "c".repeat(64),
        reviewPackageSha256: "d".repeat(64),
        reviewerRef: "operator",
    };
    const response = await fetch(`${url}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            process: "template-from-source",
            version: "v3",
            input: { ...approval, note: "本轮编译要求" },
        }),
    });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.output.template.runtimeSemantics.version).toBe(4);
    expect(
        result.output.template.runtimeSemantics.visualContract,
    ).toBeUndefined();
    expect(result.output.template.cover).toBe(imageUrl);
    expect(result.output.template.referenceImage).toBe(imageUrl);
    expect(result.output.preparedImage.sha256).toBe(approval.objectSha256);
    expect(preparation.finalize).toHaveBeenCalledWith(
        approval,
        expect.any(AbortSignal),
    );
    expect(preparation.render).not.toHaveBeenCalled();
    expect(deps.agent.compile).toHaveBeenCalledWith(
        expect.objectContaining({ note: "本轮编译要求" }),
    );
    expect(deps.loadImage).toHaveBeenCalledWith(
        imageUrl,
        expect.any(AbortSignal),
    );
    expect(deps.agent.compile).toHaveBeenCalledOnce();
    expect(deps.agent.review).toHaveBeenCalledOnce();
    if (process.env.PIPIPI_V4_CONTRACT_OUTPUT)
        writeFileSync(
            process.env.PIPIPI_V4_CONTRACT_OUTPUT,
            `${JSON.stringify(result.output, null, 2)}\n`,
        );
    const legacyResponse = await fetch(`${url}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            process: "template-from-image",
            version: "v1",
            input: { imageUrl },
        }),
    });
    expect(legacyResponse.status).toBe(200);
    expect(
        (await legacyResponse.json()).output.template.runtimeSemantics.version,
    ).toBe(2);
    expect(oldCompile).toHaveBeenCalledOnce();
});
it("结构不可读只重编译一次，然后独立复核；模型执行错误不重投", async () => {
    const deps = dependencies();
    deps.agent.compile.mockRejectedValueOnce(
        new AgentJsonSyntaxError("not-json"),
    );
    expect((await run(deps)).status).toBe("succeeded");
    expect(deps.agent.compile).toHaveBeenCalledTimes(2);
    expect(deps.agent.review).toHaveBeenCalledOnce();
    const failed = dependencies();
    failed.agent.compile.mockRejectedValue(
        new AgentExecutionFailure({ stage: "request", code: "connection" }),
    );
    expect(await run(failed)).toMatchObject({
        status: "failed",
        error: { code: "AGENT_FAILURE" },
    });
    expect(failed.agent.compile).toHaveBeenCalledOnce();
    expect(failed.agent.review).not.toHaveBeenCalled();
});
it("复核拒绝保留具体检查，结构错误保留安全字段，动态键仅显示星号", () => {
    const value = fixture();
    const broken = structuredClone(value);
    broken.draft.runtimeSemantics.designSpec.defaults.accentSources.private_key =
        "示例";
    expect(() => readCandidate(broken)).toThrowError(
        expect.objectContaining({
            diagnostic: expect.objectContaining({
                issues: expect.arrayContaining([
                    {
                        path: "/draft/runtimeSemantics/designSpec/defaults/accentSources/*",
                        code: "expected_accent_element",
                    },
                ]),
            }),
        }),
    );
    const report = review(value);
    report.checks.printForm.passed = false;
    report.checks.inputBindings.passed = false;
    report.issues.push({
        check: "printForm",
        path: "/draft/runtimeSemantics/designSpec/whole/printForm",
        reason: "私有复核正文",
    });
    expect(() => applyReview(value, report)).toThrowError(
        expect.objectContaining({
            diagnostic: {
                stage: "schema",
                code: "invalid_contract",
                issues: [
                    {
                        path: "/review/checks/printForm/passed",
                        code: "check_failed",
                    },
                    {
                        path: "/review/checks/inputBindings/passed",
                        code: "check_failed",
                    },
                    {
                        path: "/review/checks/printForm",
                        code: "unresolved_review",
                    },
                    {
                        path: "/draft/runtimeSemantics/designSpec/whole/printForm",
                        code: "review_evidence",
                    },
                    {
                        path: "/draft/runtimeSemantics/designSpec",
                        code: "review_evidence",
                    },
                    {
                        path: "/draft/runtimeSemantics/designSpec",
                        code: "review_evidence",
                    },
                ],
            },
        }),
    );
    expect(() =>
        readCandidate({
            ...value,
            draft: {
                ...value.draft,
                runtimeSemantics: {
                    ...value.draft.runtimeSemantics,
                    inputBindings: {
                        secret: {
                            operation: "replace_content",
                            targetIds: ["test"],
                            distributionPolicy: "replace_as_unit",
                        },
                    },
                },
            },
        }),
    ).toThrowError(
        expect.objectContaining({
            diagnostic: expect.objectContaining({
                issues: expect.arrayContaining([
                    {
                        path: "/draft/runtimeSemantics/inputBindings/*/valueKind",
                        code: "invalid_value",
                    },
                ]),
            }),
        }),
    );
});
it("复核补丁修改后完整重验，不补造通过结论，不改变原候选", () => {
    const value = fixture();
    const before = structuredClone(value);
    const report = review(value);
    report.changes.push({
        path: "/draft/title",
        valueJson: JSON.stringify("新标题"),
    });
    expect(applyReview(value, report).draft.title).toBe("新标题");
    expect(value).toEqual(before);
    const bad = review(value);
    bad.reviewedCandidateSha256 = "f".repeat(64);
    expect(() => applyReview(value, bad)).toThrow();
    const blocked = review(value);
    blocked.issues.push({
        check: "imageFidelity",
        path: "/observation/overview",
        reason: "图片不能确认",
    });
    expect(() => applyReview(value, blocked)).toThrow();
    const wrong = review(value);
    wrong.changes.push(
        {
            path: "/draft/runtimeSemantics/designSpec/whole/printForm",
            valueJson: '"rect_patch"',
        },
        {
            path: "/draft/runtimeSemantics/designSpec/elements",
            valueJson: JSON.stringify(
                value.draft.runtimeSemantics.designSpec.elements.filter(
                    (element) => element.category !== "edge",
                ),
            ),
        },
    );
    expect(() =>
        compileResult(applyReview(value, wrong), imageUrl, image),
    ).toThrow();
    const schema = reviewSchema(value);
    expect(schema.safeParse(review(value)).success).toBe(true);
});
it.each(["binding", "default", "shapeLeak", "secondImage", "wrongVersion"])(
    "拒绝 %s 违规，不放松作者合同",
    async (reason) => {
        const value = fixture();
        if (reason === "binding")
            value.draft.runtimeSemantics.inputBindings.subject.targetIds = [
                "missing",
            ];
        if (reason === "default")
            value.draft.inputSchema.slots[0].text.defaultValue = "冲突默认值";
        if (reason === "shapeLeak")
            value.draft.runtimeSemantics.designSpec.whole.technique += "Q版";
        if (reason === "secondImage")
            value.draft.inputSchema.slots[1].image =
                value.draft.inputSchema.slots[0].image;
        if (reason === "wrongVersion")
            Object.assign(value.draft.runtimeSemantics, { version: 3 });
        const deps = dependencies();
        deps.agent.compile.mockResolvedValue(value);
        deps.agent.review.mockImplementation(async (request) =>
            review(request.candidate),
        );
        expect((await run(deps)).status).toBe("failed");
    },
);
it("语义问题由同一独立复核有界修正；不追加模型轮次或返回观察", async () => {
    const value = fixture();
    value.draft.inputSchema.slots[0].text.defaultValue = "冲突默认值";
    expect(candidateIssues(value).length).toBeGreaterThan(0);
    const deps = dependencies();
    deps.agent.compile.mockResolvedValue(value);
    deps.agent.review.mockImplementation(async (request) => {
        const result = review(request.candidate);
        result.changes.push({
            path: "/draft/inputSchema/slots/0",
            valueJson: JSON.stringify({
                ...value.draft.inputSchema.slots[0],
                text: {
                    ...value.draft.inputSchema.slots[0].text,
                    defaultValue:
                        value.draft.runtimeSemantics.designSpec.defaults
                            .subject,
                },
            }),
        });
        return result;
    });
    const result = await run(deps);
    expect(result.status).toBe("succeeded");
    expect(deps.agent.compile).toHaveBeenCalledOnce();
    expect(deps.agent.review).toHaveBeenCalledOnce();
    if (result.status === "succeeded")
        expect(result.output).not.toHaveProperty("observation");
});

it("结构修正准确指出缺失的文本展示方式与图片来源", () => {
    const raw = fixture();
    const slot = raw.draft.inputSchema.slots[0];
    Reflect.deleteProperty(slot.text, "presentation");
    if (!slot.image) throw new Error("夹具缺少图片输入");
    Reflect.deleteProperty(slot.image, "sourceOptions");
    try {
        readCandidate(raw);
        expect.fail("缺失作者字段的候选应进入修正");
    } catch (error) {
        if (!(error instanceof PrintDesignContractError)) throw error;
        expect(error.issues.join("\n")).toContain(
            "draft.inputSchema.slots.0.text.presentation",
        );
        expect(error.issues.join("\n")).toContain(
            "draft.inputSchema.slots.0.image.sourceOptions",
        );
    }
});
