import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSkillSet } from "../src/agent-runtime/skills.js";
import {
    compileTemplateResult,
    reviewAxes,
} from "../src/processes/template-from-image/contract.js";
import {
    analysisIssues,
    candidateDigest,
    reviewChecks,
    reviewIssues,
} from "../src/processes/template-from-image/quality.js";
import { createTemplateSkillRefs } from "../src/processes/template-from-image/skills.js";
import { candidate } from "./fixtures/template-candidate.js";

describe("模板质量回归", () => {
    it("纯文字槽的图片理由为 null，可作为未启用图片能力的复核依据", () => {
        const value = candidate();
        delete value.draft.inputSchema.slots[0].image;
        value.analysis.slotEvidence.subject.imageRationale = null;
        value.review.reviewedDraftSha256 = candidateDigest(value);
        value.review.checks.imageModesJustified.evidence = [
            {
                path: "/analysis/slotEvidence/subject/imageRationale",
                observation:
                    "图片理由明确为空，正式槽位只提供文字输入，不声明图片能力。",
            },
        ];
        expect(reviewIssues(value, value.review)).toEqual([]);
    });
    it("未知复核路径仍拒绝，并指出具体引用位置便于排查", () => {
        const value = candidate();
        value.review.checks.imageModesJustified.evidence = [
            {
                path: "/analysis/slotEvidence/missing/imageRationale",
                observation: "引用的槽位并不存在，不能作为有效证据。",
            },
        ];
        expect(reviewIssues(value, value.review).join()).toContain(
            "/analysis/slotEvidence/missing/imageRationale",
        );
    });
    it("复核不能只看入选槽位，缺少任何轴的独立观察都会被指出", () => {
        const value = candidate();
        value.review.checks.slotRecallComplete.evidence = [
            {
                path: "/analysis/slotCoverageReview/subject",
                observation: "只检查中央动物身份，遗漏其他轴的独立判断",
            },
        ];
        expect(reviewIssues(value, value.review).join()).toContain(
            "slotCoverageReview/color",
        );
    });
    it("未识别身份的结论不强迫等于可见默认描述，已识别专名仍需一致", () => {
        const value = candidate();
        const identity =
            value.analysis.slotEvidence.subject.identityRecognition;
        if (!identity) throw new Error("测试身份缺少识别记录");
        identity.name = "未识别具体身份";
        expect(analysisIssues(value)).toEqual([]);
        identity.status = "recognized";
        expect(analysisIssues(value).join()).toContain(
            "已识别身份必须作为默认值",
        );
    });
    it("接受完整对应的分析和绑定最终候选的逐项复核", () => {
        const value = candidate();
        expect(analysisIssues(value)).toEqual([]);
        expect(reviewIssues(value, value.review)).toEqual([]);
    });
    it("允许来源身份声明由输入接管，但必须落实到正式视觉约束", () => {
        const value = candidate();
        const authority = value.analysis.slotEvidence.subject.featureAuthority;
        if (!authority) throw new Error("测试身份缺少特征权限");
        authority.identity.runtimeFact = "身份由输入接管";
        expect(analysisIssues(value).join()).toContain("特征执行事实必须落实");
        value.draft.runtimeSemantics.visualContract.relations.push(
            "身份由输入接管",
        );
        value.analysis.semanticModel.runtimeSemantics = structuredClone(
            value.draft.runtimeSemantics,
        );
        expect(analysisIssues(value)).toEqual([]);
    });
    it("空间关系允许在完整约束句中落实", () => {
        const value = candidate();
        value.draft.runtimeSemantics.visualContract.relations[0] =
            "双臂与中央主体保持拥抱接触，不改变接触关系";
        value.analysis.semanticModel.runtimeSemantics = structuredClone(
            value.draft.runtimeSemantics,
        );
        expect(analysisIssues(value)).toEqual([]);
    });
    it.each([
        [
            "选定画法丢失",
            (value: ReturnType<typeof candidate>) => {
                value.analysis.mediumComposition.styleTraits.push(
                    "带墨色缺口的粗短线条",
                );
            },
        ],
        [
            "推荐项没有实际代入",
            (value: ReturnType<typeof candidate>) => {
                value.analysis.slotEvidence.subject.substitutions[0].prompt =
                    "已检查推荐值";
            },
        ],
        [
            "槽位选择未通过门禁",
            (value: ReturnType<typeof candidate>) => {
                value.analysis.editableCandidates[0].gates.userMotivation.passed = false;
            },
        ],
        [
            "八轴漏掉正式控制",
            (value: ReturnType<typeof candidate>) => {
                value.analysis.slotCoverageReview.subject.slotIds = [];
            },
        ],
        [
            "锁回开放毛色事实",
            (value: ReturnType<typeof candidate>) => {
                value.analysis.slotEvidence.subject.openVisualFacts.push(
                    "柔和暖色光",
                );
            },
        ],
        [
            "固定文字没有执行约束",
            (value: ReturnType<typeof candidate>) => {
                value.analysis.textRegions.push({
                    id: "caption",
                    componentId: "pet",
                    semanticUnitId: "caption",
                    exactText: "抱抱我吧",
                    action: "preserve",
                    slotId: null,
                    evidence: "文字在画面底部清晰可见",
                });
            },
        ],
        [
            "语义模型与正式稿漂移",
            (value: ReturnType<typeof candidate>) => {
                value.analysis.semanticModel.promptTemplate = "不同的玩法";
            },
        ],
        [
            "服装归属与分析冲突",
            (value: ReturnType<typeof candidate>) => {
                value.draft.runtimeSemantics.inputBindings.subject.clothingOwnership =
                    "template";
            },
        ],
    ] as const)("拒绝%s", (_label, mutate) => {
        const value = candidate();
        mutate(value);
        expect(analysisIssues(value).length).toBeGreaterThan(0);
    });
    it("候选变动使旧复核失效，伪造路径和重复套话也被拒绝", () => {
        const value = candidate();
        value.draft.description = "新的描述";
        expect(reviewIssues(value, value.review)).toContain(
            "review 摘要与本次最终候选不符",
        );
        value.review.reviewedDraftSha256 = candidateDigest(value);
        value.review.checks[reviewChecks[0]].evidence[0].path =
            "/draft/missing";
        expect(reviewIssues(value, value.review).join()).toContain(
            "引用不存在",
        );
        for (const name of reviewChecks)
            value.review.checks[name].evidence[0].observation =
                "已检查无问题，全部合规。";
        expect(reviewIssues(value, value.review).join()).toContain("重复套话");
    });
    it("拒绝只有泛泛复核且没有图片分析的旧候选", () => {
        const draft = JSON.parse(
            readFileSync("test/fixtures/template-from-image.json", "utf8"),
        );
        const evidence = "已检查，无问题，无具体图片或字段依据。";
        const review = {
            templateValue: evidence,
            axisCoverage: Object.fromEntries(
                reviewAxes.map((axis) => [axis, evidence]),
            ),
            slotDecisions: Object.fromEntries(
                draft.inputSchema.slots.map((slot: { id: string }) => [
                    slot.id,
                    { reason: evidence, substitution: evidence },
                ]),
            ),
            visualPreservation: evidence,
            sourceIsolation: evidence,
            textRouting: evidence,
            issues: [],
        };
        expect(() =>
            compileTemplateResult(
                { draft, review },
                "https://example.com/image.png",
                {
                    data: "cG5n",
                    mimeType: "image/png",
                    width: 800,
                    height: 600,
                },
            ),
        ).toThrow();
    });
    it("真实加载器包含原始视觉规则和槽位校准案例", () => {
        const loaded = createSkillSet(
            createTemplateSkillRefs(),
            process.cwd(),
        ).load();
        expect(loaded.instructions).toContain("团队纪念照的专业图标");
        expect(loaded.instructions).toContain(
            "mediumComposition 与正式字段的对应合同",
        );
        expect(loaded.instructions).toContain("三个纵向独立主体");
        expect(loaded.instructions).toContain(
            "不要求 slotEvidence 重复保存门禁",
        );
    });
    it("八份业务正文逐文件匹配来源摘要，入口取舍直接复用原文", () => {
        const root = ".pi/skills/meme-template-json-compiler/";
        const skill = readFileSync(`${root}SKILL.md`, "utf8");
        const manifest = JSON.parse(
            readFileSync(`${root}source-manifest.json`, "utf8"),
        ) as { files: { path: string; sha256: string }[] };
        const sections = [
            ...skill.matchAll(
                /<!-- source: ([^>]+) -->\n\n([\s\S]*?)(?=\n<!-- source: |$)/g,
            ),
        ];
        expect(sections).toHaveLength(8);
        expect(new Set(sections.map((section) => section[1])).size).toBe(8);
        for (const [, path, body] of sections) {
            // 固定来源为 CRLF；兼容 LF 来源但不忽略正文的任何差异。
            const normalized = `${body.trim()}\n`;
            const hashes = [normalized, normalized.replace(/\n/g, "\r\n")].map(
                (text) => createHash("sha256").update(text).digest("hex"),
            );
            expect(hashes, path).toContain(
                manifest.files.find((file) => file.path === path)?.sha256,
            );
        }
        const fields = sections.find(
            (section) => section[1] === "references/authoring-fields.md",
        )?.[2];
        const policy = fields
            ?.split("\n")
            .find((line) => line.startsWith("普通餐食、背景小物"));
        expect(policy).toBeTruthy();
        expect(skill.split("<!-- source:")[0]).toContain(policy);
        expect(skill).not.toContain("多槽不是质量目标");
    });
});
