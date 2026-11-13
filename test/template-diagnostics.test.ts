import { describe, expect, it } from "vitest";
import { sanitizeActivityDiagnostic } from "../src/process-runtime/diagnostics.js";
import {
    compileTemplateResult,
    parseTemplateCandidate,
    TemplateContractError,
} from "../src/processes/template-from-image/contract.js";
import { validationDiagnostics } from "../src/processes/template-from-image/diagnostics.js";
import {
    readTemplatePlan,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import { candidate, reviewFor } from "./fixtures/template-candidate.js";

describe("模板诊断边界", () => {
    it("只保留静态字段、受限索引和错误类型，并限制数量与深度", () => {
        const issues = validationDiagnostics(
            Array.from({ length: 30 }, () => ({
                path: [
                    "analysis",
                    "slotEvidence",
                    "secret-token",
                    "featureAuthority",
                    2,
                    "https://private",
                    ...Array(25).fill("secret"),
                ],
                code: "private-error-message",
            })),
        );
        expect(issues).toHaveLength(16);
        expect(issues[0].path.split("/")).toHaveLength(21);
        expect(issues[0]).toMatchObject({ code: "contract" });
        expect(issues[0].path).toContain(
            "/analysis/slotEvidence/*/featureAuthority/2/*",
        );
        expect(JSON.stringify(issues)).not.toMatch(/secret|private|https/);
    });
    it("动态槽名与静态字段重名时仍被隐藏", () => {
        expect(
            validationDiagnostics([
                {
                    path: [
                        "analysis",
                        "slotEvidence",
                        "subject",
                        "openVisualFacts",
                    ],
                    code: "coverage_mismatch",
                },
            ]),
        ).toEqual([
            {
                path: "/analysis/slotEvidence/*/openVisualFacts",
                code: "coverage_mismatch",
            },
        ]);
    });
    it("初稿与最终活动都能区分来源规则、组件覆盖和媒介投影", () => {
        const value = candidate();
        const evidence = value.analysis.slotEvidence.subject;
        evidence.openVisualFacts = evidence.openVisualFacts.filter(
            (fact) =>
                fact !== value.draft.inputSchema.slots[0].text.defaultValue,
        );
        value.analysis.mediumComposition.medium = "另一种媒介";
        const component = value.analysis.componentGraph[0];
        for (const axis of Object.values(value.analysis.slotCoverageReview)) {
            axis.componentIds = axis.componentIds.filter(
                (id) => id !== component.id,
            );
        }
        value.review = reviewFor(value);
        const expected = [
            { path: "/analysis/componentGraph/0", code: "coverage_mismatch" },
            {
                path: "/analysis/slotEvidence/*/openVisualFacts",
                code: "coverage_mismatch",
            },
            {
                path: "/analysis/mediumComposition/medium",
                code: "value_mismatch",
            },
        ];
        expect(() => parseTemplateCandidate(value)).toThrow(
            expect.objectContaining({
                diagnostics: expect.arrayContaining(expected),
            }),
        );
        try {
            compileTemplateResult(value, "https://example.com/reference.png", {
                data: "AAAA",
                mimeType: "image/png",
                width: 800,
                height: 800,
            });
            throw new Error("应拒绝本轮候选");
        } catch (error) {
            if (!(error instanceof TemplateContractError)) throw error;
            const activity = sanitizeActivityDiagnostic({
                stage: "schema",
                code: "invalid_contract",
                issues: error.diagnostics,
            });
            expect(activity?.issues).toEqual(expect.arrayContaining(expected));
            expect(JSON.stringify(activity?.issues)).not.toMatch(
                /另一种媒介|analysis_contract/,
            );
        }
    });
    it("草稿必填字段错误穿过引用计划仍保留诊断路径", () => {
        const plan = toTemplatePlan(candidate());
        const draft = { ...plan.draft } as Record<string, unknown>;
        delete draft.title;
        expect(() => readTemplatePlan({ ...plan, draft })).toThrow(
            expect.objectContaining({
                diagnostics: expect.arrayContaining([
                    { path: "/draft/title", code: "required" },
                ]),
            }),
        );
    });
});
