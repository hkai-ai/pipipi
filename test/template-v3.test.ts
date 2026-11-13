import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import type { TemplateAgent } from "../src/processes/template-from-image/agent.js";
import { templateInspectionResponseSchema } from "../src/processes/template-from-image/compact.js";
import {
    compileTemplateResult,
    templateOutputSchema,
    templateV3OutputSchema,
} from "../src/processes/template-from-image/contract.js";
import {
    materializeTemplatePlan,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import { sourceAnalysisIssues } from "../src/processes/template-from-image/quality.js";
import { createTemplateRegistration } from "../src/processes/template-from-image/registration.js";
import { templateRepairContext } from "../src/processes/template-from-image/repair-context.js";
import { candidate } from "./fixtures/template-candidate.js";
import { ownershipCandidate, ownershipReview } from "./fixtures/template-v3.js";

const image = {
    data: "cG5n",
    mimeType: "image/png" as const,
    width: 800,
    height: 600,
};
const imageUrl = "https://images.example.com/approved.png";
const compiled = () =>
    compileTemplateResult(ownershipCandidate(), imageUrl, image);

describe("模板归属 v3", () => {
    it("输出按准确版本校验，旧接口不接受新结果，新接口不降级旧结果", () => {
        const template = compiled();
        expect(templateV3OutputSchema.safeParse({ template }).success).toBe(
            true,
        );
        expect(templateOutputSchema.safeParse({ template }).success).toBe(
            false,
        );
        const legacy = compileTemplateResult(candidate(), imageUrl, image);
        expect(
            templateOutputSchema.safeParse({ template: legacy }).success,
        ).toBe(true);
        expect(
            templateV3OutputSchema.safeParse({ template: legacy }).success,
        ).toBe(false);
    });
    it("目标默认外观可以保存，不能泄漏为替换后仍保留的姿势", () => {
        const value = ownershipCandidate();
        const defaultValue = value.draft.inputSchema.slots[0].text.defaultValue;
        value.draft.runtimeSemantics.targetInstances[0].appearance = [
            defaultValue,
        ];
        value.analysis.semanticModel.runtimeSemantics = structuredClone(
            value.draft.runtimeSemantics,
        );
        value.review = ownershipReview(value);
        expect(() =>
            compileTemplateResult(value, imageUrl, image),
        ).not.toThrow();
        value.draft.runtimeSemantics.targetInstances[0].pose = [defaultValue];
        value.analysis.semanticModel.runtimeSemantics = structuredClone(
            value.draft.runtimeSemantics,
        );
        value.review = ownershipReview(value);
        expect(() => compileTemplateResult(value, imageUrl, image)).toThrow();
    });
    it.each([
        "missing_target",
        "missing_observation",
        "duplicate_global",
        "missing_review",
        "uncertain",
        "missing_binding",
    ])("拒绝 %s 而不补造事实", (reason) => {
        const value = ownershipCandidate();
        if (reason === "missing_target")
            value.analysis.visualSelections[1].factRefs = [
                { targetId: "unknown", field: "appearance", index: 0 },
            ];
        if (reason === "missing_observation")
            value.analysis.visualSelections[1].decision = "omit";
        if (reason === "duplicate_global")
            value.draft.runtimeSemantics.visualContract.styleTraits.push(
                "红色短毛，尖耳和圆脸",
            );
        if (reason === "missing_binding")
            value.draft.runtimeSemantics.inputBindings.subject.targetIds = [
                "unknown",
            ];
        value.analysis.semanticModel.runtimeSemantics = structuredClone(
            value.draft.runtimeSemantics,
        );
        value.review = ownershipReview(value);
        if (reason === "missing_review")
            value.review.checks.visualContractRespectsInputs.evidence.pop();
        if (reason === "uncertain")
            value.review.checks.visualContractRespectsInputs.passed = false;
        expect(() => compileTemplateResult(value, imageUrl, image)).toThrow();
    });
    it("目标引用贯穿计划展开、修正上下文和独立复核", () => {
        const value = ownershipCandidate();
        value.analysis.templateValue.backendOnlyFacts.push(
            "右手抬起，站在画面中央",
        );
        value.analysis.spatialRelations.push({
            componentIds: [value.analysis.componentGraph[0].id],
            evidence: "手臂抬起",
            runtimeFact: "右手抬起，站在画面中央",
        });
        const plan = toTemplatePlan(value);
        const expanded = materializeTemplatePlan(plan);
        expect(expanded.draft).toEqual(value.draft);
        expect(expanded.analysis.spatialRelations.at(-1)?.runtimeFact).toBe(
            "右手抬起，站在画面中央",
        );
        const context = templateRepairContext(plan);
        expect(context.visualSelectionIssues).toEqual([]);
        expect(context.unresolvedRelations).toEqual([]);
        expect(
            context.visualSelections[1].decisions[0].facts[0].path,
        ).toContain("/targetInstances/0/appearance/0");
        const schema = templateInspectionResponseSchema(plan, "a".repeat(64));
        const fields =
            schema.shape.review.shape.checks.shape.visualContractRespectsInputs
                .shape.evidence.shape;
        expect(fields).toHaveProperty("targetInstances");
    });
    it("同一观察可分组保留多个不同事实，摘要及候选原文不变", () => {
        const value = ownershipCandidate();
        const selection = value.analysis.visualSelections[1];
        const removed = value.analysis.visualSelections.pop();
        if (!removed) throw new Error("测试缺少姿势观察");
        const refs = removed.factRefs;
        value.analysis.fieldEvidence.visualContract[1] +=
            "；右手抬起，站在画面中央";
        value.analysis.fieldEvidence.visualContract.pop();
        expect(refs.length).toBeGreaterThan(0);
        value.analysis.visualSelections.push({ ...selection, factRefs: refs });
        value.review = ownershipReview(value);
        const before = JSON.stringify(value);
        expect(() =>
            compileTemplateResult(value, imageUrl, image),
        ).not.toThrow();
        expect(JSON.stringify(value)).toBe(before);
        const last = value.analysis.visualSelections.at(-1);
        if (!last) throw new Error("测试缺少拆分记录");
        last.decision = "omit";
        last.factRefs = [];
        value.review = ownershipReview(value);
        expect(() => compileTemplateResult(value, imageUrl, image)).toThrow();
    });
    it("重复引用和缺失观察仍拒绝，不以多行取舍绕过事实对账", () => {
        for (const missing of [false, true]) {
            const value = ownershipCandidate();
            if (missing) value.analysis.visualSelections.pop();
            else
                value.analysis.visualSelections.push(
                    structuredClone(value.analysis.visualSelections[1]),
                );
            value.review = ownershipReview(value);
            expect(() =>
                compileTemplateResult(value, imageUrl, image),
            ).toThrow();
        }
    });
    it("外观长文本逐字保留且与输入合同版本分离", () => {
        const value = ownershipCandidate();
        value.draft.runtimeSemantics.targetInstances[0].appearance = [
            "可见细节".repeat(120),
        ];
        value.analysis.semanticModel.runtimeSemantics = structuredClone(
            value.draft.runtimeSemantics,
        );
        value.review = ownershipReview(value);
        const result = compileTemplateResult(value, imageUrl, image);
        expect(
            result.runtimeSemantics.targetInstances[0].appearance?.[0],
        ).toHaveLength(480);
        expect(result.inputSchema.version).toBe(2);
    });
});

describe("HTTP 精确版本联通", () => {
    const applications: ReturnType<typeof createProcessingApplication>[] = [];
    afterEach(async () => {
        await Promise.all(applications.splice(0).map((app) => app.close()));
    });
    it.each([true, false])(
        "最终复核阻断只修正已审核候选一次（能解决=%s）",
        async (canRepair) => {
            const first = ownershipCandidate();
            const originalPlan = toTemplatePlan(first);
            const patchedPlan = toTemplatePlan(first);
            patchedPlan.draft.description = "第一次复核修改的描述";
            const compile = vi.fn(async () => originalPlan);
            const loadImage = vi.fn(async () => image);
            const review = vi
                .fn<TemplateAgent["review"]>()
                .mockImplementationOnce(async (request) => {
                    request.onPatchedPlan?.(patchedPlan);
                    const result = materializeTemplatePlan(patchedPlan);
                    const report = ownershipReview(result);
                    report.issues.push("描述与已批准图片不符");
                    return { ...result, review: report };
                })
                .mockImplementationOnce(async (request) => {
                    expect(request.plan).toEqual(patchedPlan);
                    expect(request.fieldIssues).toContainEqual({
                        path: "/review/issues",
                        code: "unresolved_review",
                    });
                    expect(request.issues.join(" ")).toContain(
                        "描述与已批准图片不符",
                    );
                    const result = materializeTemplatePlan(request.plan);
                    if (canRepair) result.draft.description = "已修正的描述";
                    return { ...result, review: ownershipReview(result) };
                });
            const app = createProcessingApplication({
                executor: createProcessExecutor({
                    registrations: [
                        createTemplateRegistration({
                            runtimeVersion: 3,
                            agent: { compile, review },
                            loadImage,
                        }),
                    ],
                }),
            });
            applications.push(app);
            const address = await app.listen();
            const response = await fetch(`${address.url}/execute`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    process: "template-from-image",
                    version: "v2",
                    input: { imageUrl },
                }),
            });
            expect(response.status).toBe(canRepair ? 200 : 502);
            expect(review).toHaveBeenCalledTimes(2);
            expect(compile).toHaveBeenCalledOnce();
            expect(loadImage).toHaveBeenCalledOnce();
        },
    );
    it("同一服务保留 v1，并在 v2 两次调用内交付可解析归属模板", async () => {
        const compile = vi.fn(async () => toTemplatePlan(ownershipCandidate()));
        const review = vi.fn(async () => ownershipCandidate());
        const registrations = [
            createTemplateRegistration({
                agent: {
                    compile: async () => toTemplatePlan(candidate()),
                    review: async () => candidate(),
                },
                loadImage: async () => image,
            }),
            createTemplateRegistration({
                runtimeVersion: 3,
                agent: { compile, review },
                loadImage: async () => image,
            }),
        ];
        const app = createProcessingApplication({
            executor: createProcessExecutor({ registrations }),
        });
        applications.push(app);
        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        for (const [version, expected] of [
            ["v1", 2],
            ["v2", 3],
        ] as const) {
            const response = await fetch(`${address.url}/execute`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    process: "template-from-image",
                    version,
                    input: { imageUrl },
                }),
            });
            const body = await response.json();
            expect(response.status).toBe(200);
            expect(body).toMatchObject({
                status: "succeeded",
                output: {
                    template: { runtimeSemantics: { version: expected } },
                },
            });
        }
        expect(compile).toHaveBeenCalledTimes(1);
        expect(review).toHaveBeenCalledTimes(1);
    });
});

it("目标引用尚未修复时也向唯一复核报告固定文字遗漏", () => {
    const value = ownershipCandidate();
    const issues = sourceAnalysisIssues(value.draft, {
        ...value.analysis,
        textRegions: [
            { id: "heading", action: "preserve", exactText: "MY PET PORTRAIT" },
        ],
    });
    expect(issues).toContain(
        "heading: 固定文字必须逐字保留在视觉约束，不能只保留“标题”等摘要",
    );
    value.draft.runtimeSemantics.visualContract.relations.push(
        "标题逐字保留 MY PET PORTRAIT",
    );
    expect(
        sourceAnalysisIssues(value.draft, {
            ...value.analysis,
            textRegions: [
                {
                    id: "heading",
                    action: "preserve",
                    exactText: "MY PET PORTRAIT",
                },
            ],
        }),
    ).toEqual([]);
});

it("媒介事实在原始观察与后端引用间使用同一非数组引用", () => {
    const value = ownershipCandidate();
    value.analysis.templateValue.backendOnlyFacts.push(
        value.draft.runtimeSemantics.visualContract.medium,
    );
    const plan = toTemplatePlan(value);
    expect(plan.analysis.templateValue.backendFactRefs).toContainEqual({
        field: "medium",
        index: null,
    });
    expect(
        materializeTemplatePlan(plan).analysis.templateValue.backendOnlyFacts,
    ).toEqual(value.analysis.templateValue.backendOnlyFacts);
    plan.analysis.templateValue.backendFactRefs[0] = {
        field: "medium",
        index: 0,
    };
    expect(() => materializeTemplatePlan(plan)).toThrow();
});

it("独立复核取得遗漏目标事实的准确路径与引用，不能仅凭通过声明放行", () => {
    const value = ownershipCandidate();
    const target = value.draft.runtimeSemantics.targetInstances[0];
    value.analysis.visualSelections = value.analysis.visualSelections.map(
        (selection) => ({
            ...selection,
            factRefs: selection.factRefs.filter(
                (ref) =>
                    !(
                        "targetId" in ref &&
                        ref.targetId === target.id &&
                        ref.field === "appearance" &&
                        ref.index === 0
                    ),
            ),
        }),
    );
    const context = templateRepairContext(toTemplatePlan(value));
    expect(context.unreferencedTargetFacts).toContainEqual({
        path: "/analysis/semanticModel/runtimeSemantics/targetInstances/0/appearance/0",
        fact: target.appearance?.[0],
        requiredRef: { targetId: target.id, field: "appearance", index: 0 },
    });
    expect(() => compileTemplateResult(value, imageUrl, image)).toThrow();
});

it("带引号的已保留原文通过，字段名不能充当原图文字", () => {
    const value = ownershipCandidate();
    const check = (exactText: string) =>
        sourceAnalysisIssues(value.draft, {
            ...value.analysis,
            textRegions: [{ id: "heading", action: "preserve", exactText }],
        });
    value.draft.runtimeSemantics.visualContract.relations.push(
        '标题为 Say "Hi"',
    );
    expect(check('Say "Hi"')).toEqual([]);
    expect(check("colorAndLight")).not.toEqual([]);
});
