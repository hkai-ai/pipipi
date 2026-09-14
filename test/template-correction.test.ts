import { describe, expect, it } from "vitest";
import {
    applyTemplateCorrection,
    templateCorrectionPaths,
} from "../src/processes/template-from-image/correction.js";
import { candidate } from "./fixtures/template-candidate.js";

describe("模板字段补丁", () => {
    it("请求路径只包含现有安全字段，保留转义且超限时可替换父容器", () => {
        const previous = {
            draft: {
                items: Array.from({ length: 300 }, (_, index) => ({ index })),
            },
            analysis: JSON.parse('{"a/b~c":1,"__proto__":{},"constructor":{}}'),
        };
        const paths = templateCorrectionPaths(previous);
        expect(paths).toHaveLength(250);
        expect(paths).toContain("/draft/items");
        expect(paths).toContain("/analysis/a~1b~0c");
        expect(paths.some((path) => /__proto__|constructor/.test(path))).toBe(
            false,
        );
        for (const path of paths)
            expect(() =>
                applyTemplateCorrection(previous, {
                    changes: [{ path, value: null }],
                }),
            ).not.toThrow();
    });
    it("替换关联数组并移除临时标记，原候选和未改字段不变", () => {
        const original = candidate();
        Object.assign(original.draft.metadata, { needsReview: "等待复核" });
        const result = applyTemplateCorrection(original, {
            changes: [
                {
                    path: "/draft/metadata",
                    value: { tags: original.draft.metadata.tags },
                },
                {
                    path: "/draft/runtimeSemantics/visualContract/relations",
                    value: ["修正后的接触关系"],
                },
            ],
        });
        expect(result).toMatchObject({
            draft: {
                metadata: { tags: original.draft.metadata.tags },
                promptTemplate: original.draft.promptTemplate,
            },
        });
        expect((result as typeof original).draft.metadata).not.toHaveProperty(
            "needsReview",
        );
        expect(original.draft.metadata).toHaveProperty("needsReview");
        expect(
            original.draft.runtimeSemantics.visualContract.relations,
        ).not.toEqual(["修正后的接触关系"]);
    });
    it.each([
        "/draft",
        "/review/passed",
        "/draft/missing",
        "/draft/__proto__/polluted",
        "/analysis/constructor/prototype",
        "/draft/inputSchema/slots/length",
        "/draft/title~2",
    ])("拒绝越界或无效路径 %s", (path) => {
        expect(() =>
            applyTemplateCorrection(candidate(), {
                changes: [{ path, value: true }],
            }),
        ).toThrow();
    });
    it("拒绝重复或互相覆盖的补丁", () => {
        for (const second of ["/draft/metadata", "/draft/metadata/tags"])
            expect(() =>
                applyTemplateCorrection(candidate(), {
                    changes: [
                        { path: "/draft/metadata", value: { tags: [] } },
                        { path: second, value: [] },
                    ],
                }),
            ).toThrow();
    });
});
