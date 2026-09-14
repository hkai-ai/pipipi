import { readFileSync } from "node:fs";
import {
    candidateDigest,
    reviewAxes,
    reviewChecks,
    type TemplateAnalysis,
    type TemplateCandidate,
} from "../../src/processes/template-from-image/quality.js";
import type { TemplateDraft } from "../../src/processes/template-from-image/types.js";

// 合同测试用的拥抱动物分析，不代表真实模型的视觉验收。
export function candidate() {
    const draft: TemplateDraft = JSON.parse(
        readFileSync("test/fixtures/template-from-image.json", "utf8"),
    );
    const analysis: TemplateAnalysis = {
        templateValue: {
            whySelected: "双臂环抱动物表达亲密与依恋",
            templateHook: "用户把自己的宠物放入双臂环抱的温暖画面",
            fixedMechanism: ["保持拥抱接触"],
            backendOnlyFacts: ["身份目标完整重绘并统一为温暖手绘媒介"],
        },
        playDecisionModel: {
            funProposition: "将自己的宠物变成被抱住的画面主角",
            userRecreationWish: "用户想把自家宠物放进被双臂紧紧抱住的画面",
            coreUserDecisions: [
                {
                    decisionId: "pet_identity",
                    description: "选择被抱住的宠物身份",
                    slotId: "subject",
                    evidence: "画面中央可寻址的动物被两侧手臂抱住",
                },
            ],
        },
        componentGraph: [
            {
                id: "pet",
                evidence: "中央动物与两侧手臂构成拥抱接触",
                targetIds: ["subject_main"],
                visualFields: [
                    "medium",
                    "styleTraits",
                    "composition",
                    "relations",
                    "colorAndLight",
                ],
            },
        ],
        identityTopology: [
            {
                identityId: "pet_identity",
                componentIds: ["pet"],
                targetIds: ["subject_main"],
                evidence: "中央仅一个被抱住的身份实例",
            },
        ],
        textRegions: [],
        mediumComposition: {
            medium: draft.runtimeSemantics.visualContract.medium,
            styleTraits: [...draft.runtimeSemantics.visualContract.styleTraits],
            composition: [...draft.runtimeSemantics.visualContract.composition],
            colorAndLight: [
                ...draft.runtimeSemantics.visualContract.colorAndLight,
            ],
        },
        spatialRelations: [
            {
                componentIds: ["pet"],
                evidence: "两侧手臂接触并包围中央动物",
                runtimeFact: "保持拥抱接触",
            },
        ],
        slotCoverageReview: Object.fromEntries(
            reviewAxes.map((axis) => [
                axis,
                {
                    componentIds: ["pet"],
                    slotIds: axis === "subject" ? ["subject"] : [],
                    evidence: `${axis} 轴以中央动物和双臂关系为根据，本测试图仅开放动物身份。`,
                },
            ]),
        ) as TemplateAnalysis["slotCoverageReview"],
        editableCandidates: [
            {
                componentId: "pet",
                axis: "subject",
                slotId: "subject",
                evidence: "宠物身份替换保留被抱住的动作",
                gates: {
                    userMotivation: {
                        passed: true,
                        evidence: "用户自然希望换成自家宠物",
                    },
                    independentUserChoice: {
                        passed: true,
                        evidence: "宠物身份可以独立选择",
                    },
                    meaningfulVariation: {
                        passed: true,
                        evidence: "不同毛色品种会形成明显版本",
                    },
                    visuallyVisible: {
                        passed: true,
                        evidence: "宠物占据中央视觉焦点",
                    },
                    modelControllable: {
                        passed: true,
                        evidence: "单图身份与单目标一对一绑定",
                    },
                    mechanismPreserved: {
                        passed: true,
                        evidence: "身份变化不改变双臂环抱关系",
                    },
                },
            },
        ],
        slotEvidence: {
            subject: {
                decisionId: "pet_identity",
                componentIds: ["pet"],
                defaultValue: "橘白猫",
                semanticAxis: "宠物身份与品种",
                granularity: "一个具体宠物身份",
                selectionReason: "identity_control",
                openVisualFacts: ["橘白猫"],
                imageRationale: "用户上传一张自己的宠物照映射中央身份",
                featureAuthority: Object.fromEntries(
                    [
                        "identity",
                        "body",
                        "ageStage",
                        "hair",
                        "clothing",
                        "accessories",
                        "expression",
                        "pose",
                        "action",
                    ].map((axis) => [
                        axis,
                        {
                            owner: "source",
                            basis: "identity_fidelity",
                            evidence: `${axis} 在测试设定中跟随动物身份`,
                            runtimeFact: null,
                        },
                    ]),
                ) as NonNullable<
                    TemplateAnalysis["slotEvidence"][string]["featureAuthority"]
                >,
                identityRecognition: {
                    status: "unrecognized",
                    name: "橘白猫",
                    evidence: "没有具体专名证据，以可见毛色描述",
                },
                groupDecision: null,
                substitutions: draft.inputSchema.slots[0].text.suggestions.map(
                    (value) => ({
                        value,
                        prompt: `双臂紧紧抱住画面中央的${value}。`,
                        evidence: `代入${value}仍保留双臂环抱且不锁定旧毛色`,
                    }),
                ),
            },
        },
        titleEvidence: {
            templateGrounded: "标题描述图中的双臂拥抱",
            usageMotivation: "表达用户想抱住自己的主角",
            spokenNaturalness: "采用日常动作表达",
            slotPortability: "不同宠物仍是画面主角",
            userAppeal: "亲密关系吸引用户替换宠物",
            discoveryValue: "标题承接拥抱宠物的检索意图",
        },
        descriptionEvidence: {
            userFacing: "描述说明可以更换中央主角",
            complementsTitle: "补充标题中的替换方式",
            spokenNaturalness: "采用用户可理解的主角表达",
            slotPortability: "不绑定某个默认品种",
        },
        tagEvidence: Object.fromEntries(
            draft.metadata.tags.map((tag) => [
                tag,
                {
                    visualEvidence: `${tag} 源于本测试图的动物拥抱关系`,
                    searchIntent: `用户通过${tag}寻找宠物拥抱模板`,
                    category: "relation" as const,
                },
            ]),
        ),
        semanticModel: {
            promptTemplate: draft.promptTemplate,
            runtimeSemantics: structuredClone(draft.runtimeSemantics),
        },
    };
    return { draft, analysis, review: reviewFor({ draft, analysis }) };
}

export function reviewFor(value: TemplateCandidate) {
    return {
        reviewedDraftSha256: candidateDigest(value),
        checks: Object.fromEntries(
            reviewChecks.map((name) => [
                name,
                {
                    passed: true,
                    evidence:
                        name === "slotRecallComplete"
                            ? reviewAxes.map((axis) => ({
                                  path: `/analysis/slotCoverageReview/${axis}`,
                                  observation: `${axis}：本测试图核对该轴的动物拥抱事实及是否有独立控制。`,
                              }))
                            : [
                                  {
                                      path: "/analysis/templateValue/templateHook",
                                      observation: `${name}：本测试候选以中央动物的拥抱玩法为核对依据。`,
                                  },
                              ],
                },
            ]),
        ),
        issues: [] as string[],
    };
}
