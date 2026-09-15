import type { ReplacementStrategy } from "../../src/processes/template-from-source/strategy.js";
export function imageStrategy(): ReplacementStrategy {
    const facts = {
        roleFunction: "被抱住的宠物",
        ageStage: "成年",
        genderPresentation: "未指定",
        count: 1 as const,
        category: "cat" as const,
    };
    const observation = "中央单只猫被双手环抱，保留拥抱接触";
    return {
        replacementTarget: "中央灰猫",
        replacementValue: "橘白猫",
        replacementComponentIds: ["body"],
        sourceCategory: "cat",
        selectedCategory: "cat",
        replacementIdentityOrigin: null,
        crossCategoryMechanism: null,
        sourceIdentityFingerprint: "gray-cat",
        selectedIdentityFingerprint: "orange-cat",
        identityResearch: {
            required: false,
            conclusion: "普通家猫",
            confidence: 1,
            evidenceRefs: [],
            alternatives: [],
        },
        sourceIdentityUnitIds: ["cat"],
        subjectContinuityEvidence: [
            {
                sourceMemberId: "cat",
                targetMemberId: "new-cat",
                source: facts,
                target: facts,
                evidence: observation,
            },
        ],
        identityBindingGroups: [
            {
                kind: "identity",
                groupId: "identity",
                sourceMemberIds: ["cat"],
                targetMemberIds: ["new-cat"],
                relationship: "单只宠物",
                requiredComponentIds: ["body"],
            },
        ],
        assetUnitIds: ["photo"],
        assetBindingGroups: [
            {
                kind: "asset",
                groupId: "asset",
                memberIds: ["photo"],
                requiredComponentIds: ["body"],
            },
        ],
        dependencyClosure: [{ componentId: "body", type: "猫全身" }],
        featureAuthority: [
            {
                componentId: "body",
                authority: "target_identity",
                instruction: "重绘橘白猫全身",
                evidence: observation,
            },
        ],
        markActions: [
            {
                regionId: "watermark",
                type: "author_watermark",
                action: "remove",
                reason: null,
                evidence: "角落账号",
            },
        ],
        textActions: [],
        operations: [
            {
                id: "replace",
                type: "identity_replace",
                targetRegion: "中央全身",
                clearOldContent: true,
                targetComponentIds: ["body"],
                stableAnchors: ["双臂"],
            },
        ],
        targetCanvas: {
            route: "standalone_design",
            targetRegion: "整图",
            carrierRole: "none",
            reason: "画面本身为独立手绘设计",
            excludedScopes: ["carrier", "environment"],
            excludedRegions: [],
        },
        frozenSet: [
            { scope: "design", regionId: "arms", instruction: "双臂拥抱接触" },
        ],
        mechanismAnalysis: {
            whyInteresting: observation,
            observableHookFeatures: ["环抱"],
            templateCriticalFeatures: ["接触"],
            evidence: observation,
        },
        visualFeatures: {
            medium: "手绘",
            composition: "居中",
            proportions: "猫全身",
            colorAndLight: "暖色",
            surface: "纸面",
            visualHook: observation,
            intentionalImperfections: "未观察到有价值的刻意缺陷",
        },
        spatialRelations: ["双手在猫身前方"],
        risks: [],
        image_size: "1024x1024",
    };
}
