import { describe, expect, it } from "vitest";
import { validationDiagnostics } from "../src/processes/template-from-image/diagnostics.js";
import {
    readTemplatePlan,
    toTemplatePlan,
} from "../src/processes/template-from-image/projection.js";
import { candidate } from "./fixtures/template-candidate.js";

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
