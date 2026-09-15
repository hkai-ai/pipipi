/** 按固定来源验证换图策略并由十二个结构段确定性编译图片指令。 */
import { z } from "zod";
import { templateImageSizes } from "./capability.js";

const text = z.string().trim().min(1).max(2000);
const texts = z.array(text).max(100);
const nonempty = texts.min(1);
const category = z.enum([
    "ordinary_person",
    "public_figure",
    "original_character",
    "anime_ip",
    "historical_figure",
    "cat",
    "dog",
    "other_animal",
    "object",
    "food",
    "scene",
    "text",
]);
const facts = z.strictObject({
    roleFunction: text,
    ageStage: text,
    genderPresentation: text,
    count: z.literal(1),
    category,
});
export const promptLabels = {
    task: "任务",
    target: "目标",
    dependencyClosure: "依赖闭包",
    identityGroups: "身份组",
    featureAuthority: "特征归属",
    canvas: "画布",
    markPolicy: "标记策略",
    frozenSet: "冻结项",
    visualFeatures: "视觉特征",
    residualCleanup: "残留清理",
    spatialRelations: "空间关系",
    output: "输出",
} as const;
const promptSections = z.strictObject({
    task: text,
    target: text,
    dependencyClosure: text,
    identityGroups: text,
    featureAuthority: text,
    canvas: text,
    markPolicy: text,
    frozenSet: text,
    visualFeatures: text,
    residualCleanup: text,
    spatialRelations: text,
    output: text,
});
export const replacementStrategySchema = z.strictObject({
    replacementTarget: text,
    replacementValue: text,
    sourceCategory: category,
    selectedCategory: category,
    replacementIdentityOrigin: z.literal("ai_generated").nullable(),
    crossCategoryMechanism: text.nullable(),
    sourceIdentityFingerprint: text,
    selectedIdentityFingerprint: text,
    identityResearch: z.strictObject({
        required: z.boolean(),
        conclusion: text,
        confidence: z.number().min(0).max(1),
        evidenceRefs: texts,
        alternatives: texts,
    }),
    sourceIdentityUnitIds: nonempty,
    subjectContinuityEvidence: z
        .array(
            z.strictObject({
                sourceMemberId: text,
                targetMemberId: text,
                source: facts,
                target: facts,
                evidence: text,
            }),
        )
        .min(1)
        .max(100),
    identityBindingGroups: z
        .array(
            z.strictObject({
                kind: z.literal("identity"),
                groupId: text,
                sourceMemberIds: nonempty,
                targetMemberIds: nonempty,
                relationship: text,
                requiredComponentIds: nonempty,
            }),
        )
        .min(1)
        .max(100),
    assetUnitIds: nonempty,
    assetBindingGroups: z
        .array(
            z.strictObject({
                kind: z.literal("asset"),
                groupId: text,
                memberIds: nonempty,
                requiredComponentIds: nonempty,
            }),
        )
        .min(1)
        .max(100),
    dependencyClosure: z
        .array(z.strictObject({ componentId: text, type: text }))
        .min(1)
        .max(100),
    featureAuthority: z
        .array(
            z.strictObject({
                componentId: text,
                authority: z.enum([
                    "target_identity",
                    "template_mechanism",
                    "derived_consistency",
                ]),
                instruction: text,
                evidence: text,
            }),
        )
        .min(1)
        .max(100),
    markActions: z
        .array(
            z.strictObject({
                regionId: text,
                type: z.enum([
                    "platform_mark",
                    "author_watermark",
                    "account_mark",
                    "url",
                    "qr_code",
                    "trademark",
                    "gameplay_logo",
                    "decorative_sticker",
                    "identity_mark",
                ]),
                action: z.enum([
                    "remove",
                    "preserve",
                    "synchronize",
                    "remove_with_reason",
                ]),
                reason: text.nullable(),
                evidence: text,
            }),
        )
        .max(100),
    textActions: z
        .array(
            z.strictObject({
                regionId: text,
                role: z.enum([
                    "watermark",
                    "attribution",
                    "identity",
                    "joke",
                    "content",
                ]),
                action: z.enum([
                    "preserve",
                    "replace",
                    "remove",
                    "synchronize_identity",
                ]),
                exactText: z.string().max(2000),
                language: text,
                layout: text,
                location: text,
                jokeRole: text,
                explicitlyAuthorized: z.boolean(),
                mechanismRequiresRewrite: z.boolean(),
                genericAttribute: z.boolean(),
                neutralizationReason: text.nullable(),
                evidence: text,
            }),
        )
        .max(100),
    operations: z
        .array(
            z.strictObject({
                id: text,
                type: z.enum([
                    "identity_replace",
                    "scene_replace",
                    "mask_fill",
                    "content_replace",
                    "ordered_set",
                ]),
                targetRegion: text,
                clearOldContent: z.literal(true),
                targetComponentIds: nonempty,
                stableAnchors: texts,
            }),
        )
        .min(1)
        .max(100),
    targetCanvas: z.strictObject({
        route: z.enum([
            "standalone_design",
            "print_artwork",
            "screen_content",
            "full_scene",
        ]),
        targetRegion: text,
        excludedRegions: texts,
    }),
    frozenSet: nonempty,
    mechanismAnalysis: z.strictObject({
        whyInteresting: text,
        observableHookFeatures: nonempty,
        templateCriticalFeatures: nonempty,
        evidence: text,
    }),
    visualFeatures: z.strictObject({
        medium: text,
        composition: text,
        proportions: text,
        colorAndLight: text,
        surface: text,
        visualHook: text,
        intentionalImperfections: text,
    }),
    spatialRelations: texts,
    risks: texts,
    promptSections,
    image_size: z.enum(templateImageSizes),
});
export type ReplacementStrategy = z.infer<typeof replacementStrategySchema>;

/** 身份类别、分组、重绘组件与文字权限对账后才允许交给图片服务。 */
export function parseReplacementStrategy(value: unknown): ReplacementStrategy {
    const s = replacementStrategySchema.parse(value);
    const require = (condition: boolean) => {
        if (!condition) throw new Error("换图策略不符合固定合同");
    };
    const unique = (items: string[]) => new Set(items).size === items.length;
    const same = (left: string[], right: string[]) =>
        left.length === right.length &&
        new Set(left).size === new Set(right).size &&
        left.every((id) => right.includes(id));
    const routes: Partial<
        Record<ReplacementStrategy["sourceCategory"], string>
    > = {
        ordinary_person: "ordinary_person",
        public_figure: "ordinary_person",
        original_character: "original_character",
        anime_ip: "anime_ip",
        historical_figure: "historical_figure",
        cat: "cat",
        dog: "dog",
    };
    const route = routes[s.sourceCategory];
    require(
        route
            ? s.selectedCategory === route
            : s.sourceCategory === s.selectedCategory ||
                  Boolean(s.crossCategoryMechanism),
    );
    require(s.sourceIdentityFingerprint !== s.selectedIdentityFingerprint);
    const human = ["ordinary_person", "public_figure"].includes(
        s.sourceCategory,
    );
    require(!human || s.replacementIdentityOrigin === "ai_generated");
    require(
        !s.identityResearch.required ||
            s.identityResearch.evidenceRefs.length > 0,
    );
    require(
        !s.identityResearch.required ||
            s.identityResearch.confidence >= 0.8 ||
            s.identityResearch.alternatives.length > 0,
    );
    const components = s.dependencyClosure.map((item) => item.componentId);
    require(unique(components));
    require(
        unique(s.featureAuthority.map((item) => item.componentId)) &&
            same(
                components,
                s.featureAuthority.map((item) => item.componentId),
            ),
    );
    require(
        same(components, [
            ...new Set(s.operations.flatMap((item) => item.targetComponentIds)),
        ]),
    );
    require(unique(s.identityBindingGroups.map((item) => item.groupId)));
    const members = s.identityBindingGroups.flatMap(
        (group) => group.sourceMemberIds,
    );
    require(
        unique(members) &&
            unique(s.sourceIdentityUnitIds) &&
            same(members, s.sourceIdentityUnitIds),
    );
    const pairs: string[] = [];
    for (const group of s.identityBindingGroups) {
        require(
            unique(group.targetMemberIds) &&
                group.sourceMemberIds.length === group.targetMemberIds.length,
        );
        require(
            group.requiredComponentIds.every((id) => components.includes(id)),
        );
        group.sourceMemberIds.forEach((id, index) => {
            pairs.push(JSON.stringify([id, group.targetMemberIds[index]]));
        });
    }
    const evidencePairs = s.subjectContinuityEvidence.map((item) =>
        JSON.stringify([item.sourceMemberId, item.targetMemberId]),
    );
    require(unique(evidencePairs) && same(pairs, evidencePairs));
    require(
        s.subjectContinuityEvidence.every(
            (item) =>
                item.source.category === s.sourceCategory &&
                item.target.category === s.selectedCategory,
        ),
    );
    const assets = s.assetBindingGroups.flatMap((group) => group.memberIds);
    require(
        unique(assets) &&
            unique(s.assetUnitIds) &&
            same(assets, s.assetUnitIds) &&
            !assets.some((id) => members.includes(id)),
    );
    require(
        unique(
            [...s.identityBindingGroups, ...s.assetBindingGroups].map(
                (group) => group.groupId,
            ),
        ),
    );
    require(
        s.assetBindingGroups.every((group) =>
            group.requiredComponentIds.every((id) => components.includes(id)),
        ),
    );
    require(
        unique(s.markActions.map((item) => item.regionId)) &&
            unique(s.textActions.map((item) => item.regionId)),
    );
    for (const mark of s.markActions) {
        const attribution = [
            "platform_mark",
            "author_watermark",
            "account_mark",
            "url",
            "qr_code",
        ].includes(mark.type);
        require(
            attribution ? mark.action === "remove" : mark.action !== "remove",
        );
        require(mark.action !== "remove_with_reason" || Boolean(mark.reason));
    }
    for (const region of s.textActions) {
        if (["watermark", "attribution"].includes(region.role))
            require(region.action === "remove");
        if (region.role === "identity") {
            require(
                human
                    ? ["remove", "replace"].includes(region.action)
                    : ["synchronize_identity", "remove"].includes(
                          region.action,
                      ),
            );
            if (human && region.action === "replace")
                require(
                    region.genericAttribute &&
                        Boolean(region.neutralizationReason),
                );
        }
        if (
            ["joke", "content"].includes(region.role) &&
            region.action !== "preserve"
        )
            require(
                region.explicitlyAuthorized || region.mechanismRequiresRewrite,
            );
        if (region.action !== "remove")
            require(Boolean(region.exactText.trim()));
    }
    require(
        s.promptSections.visualFeatures.includes(
            s.visualFeatures.intentionalImperfections,
        ),
    );
    return s;
}

export function compileReplacementPrompt(
    strategy: ReplacementStrategy,
): string {
    return Object.entries(promptLabels)
        .map(
            ([key, label]) =>
                `${label}：${strategy.promptSections[key as keyof typeof promptLabels].trim()}`,
        )
        .join("\n");
}
