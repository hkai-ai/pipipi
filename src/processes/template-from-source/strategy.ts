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
    roleFunction: text.describe(
        "连续性事实：同一主体对 source 与 target 使用完全相同的角色功能表述，不把新文案或身份名写成角色变化。",
    ),
    ageStage: text.describe(
        "连续性事实：沿用 source 的年龄阶段原文；不适用时两端填写相同表述。",
    ),
    genderPresentation: text.describe(
        "连续性事实：沿用 source 的性别呈现原文；不适用时两端填写相同表述。",
    ),
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
export const replacementStrategySchema = z.strictObject({
    replacementTarget: text,
    replacementValue: text,
    replacementComponentIds: nonempty,
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
        .array(
            z.strictObject({
                componentId: text,
                type: text.describe(
                    "可辨认的重绘组件或设计特征。按特征权限拆分，不把同一物件上需要保持的机制设计并入全部替换的身份组件。",
                ),
            }),
        )
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
                instruction: text.describe(
                    "先依据原图判断该组件是否承载笑点、情绪、动作可读性、构图轮廓或模板辨识度，再说明替换、保持或派生重绘；不能只因属于替换目标就改变全部可见设计。",
                ),
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
                originalText: text,
                exactText: z.string().max(2000),
                componentId: text,
                language: text,
                layout: text.describe(
                    "按原图记录该文字区的行数、字距、字形宽高与方向，以及整行外轮廓和基线的可见变化；横排或居中不能代替这些排版事实。只记录实际可见特征，不确定处标明风险。文字等价替换仍保持语言、行数、位置和笑点方向。",
                ),
                location: text.describe(
                    "记录原图中文字区的位置，并按已选画布定位。",
                ),
                jokeRole: text.describe(
                    "原图中该文字区承担的笑点或正文作用；不得仅由新文案反推。",
                ),
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
        carrierRole: z.enum(["none", "apparel", "device", "mechanism"]),
        reason: text,
        excludedScopes: z
            .array(z.enum(["design", "carrier", "environment"]))
            .max(3),
        excludedRegions: texts,
    }),
    frozenSet: z
        .array(
            z.strictObject({
                scope: z.enum(["design", "carrier", "environment"]),
                regionId: text,
                instruction: text.describe(
                    "冻结原图中需保持的机制、构图、数量、关系、动作、空间拓扑或非目标视觉锚点；使用可核对事实，避免整体一致等宽泛表述。",
                ),
            }),
        )
        .min(1)
        .max(100),
    mechanismAnalysis: z.strictObject({
        whyInteresting: text,
        observableHookFeatures: nonempty,
        templateCriticalFeatures: nonempty,
        evidence: text,
    }),
    visualFeatures: z.strictObject({
        medium: text.describe(
            "记录原图可观察且需延续的媒介特征，按已选画布限定范围。",
        ),
        composition: text.describe(
            "记录原图主体及文字块的外轮廓、方向、对齐、留白与局部相对位置；先观察各部分之间的实际变化，再概括整体构图，不能只给出类别或风格名称。",
        ),
        proportions: text.describe(
            "记录原图需保持的可观察比例，不能用新替换值重新设计模板机制。",
        ),
        colorAndLight: text.describe(
            "记录原图可观察的色彩和光照，遵循各组件的特征权限。",
        ),
        surface: text.describe(
            "记录原图可观察的表面与纹理特征，遵循已选画布范围。",
        ),
        visualHook: text.describe(
            "记录使原图有趣、可辨认的具体视觉特征；有人脸时包括脸型、眼形、嘴型和表情语法，情绪标签不能代替观察。",
        ),
        intentionalImperfections: text.describe(
            "记录原图有价值的刻意缺陷，作为正向保留要求；没有观察到时明确说明，不编造缺陷。",
        ),
    }),
    spatialRelations: texts,
    risks: texts,
    image_size: z.enum(templateImageSizes),
});
export type ReplacementStrategy = z.infer<typeof replacementStrategySchema>;

export type StrategyField = keyof ReplacementStrategy;
export const strategyFields = Object.keys(
    replacementStrategySchema.shape,
) as StrategyField[];
export type StrategyIssue = Readonly<{
    code: string;
    fields: readonly StrategyField[];
}>;
export class StrategyValidationError extends Error {
    constructor(readonly issues: readonly StrategyIssue[]) {
        super("换图策略不符合固定合同");
    }
}

/** 身份类别、分组、重绘组件与文字权限对账后才允许交给图片服务。 */
export function parseReplacementStrategy(value: unknown): ReplacementStrategy {
    const parsed = replacementStrategySchema.safeParse(value);
    if (!parsed.success)
        throw new StrategyValidationError(
            parsed.error.issues.map((issue) => ({
                code: issue.code,
                fields: strategyFields.includes(issue.path[0] as StrategyField)
                    ? [issue.path[0] as StrategyField]
                    : [],
            })),
        );
    const s = parsed.data;
    const issues: StrategyIssue[] = [];
    const require = (
        condition: boolean,
        code: string,
        fields: StrategyField[],
    ) => {
        if (!condition) issues.push({ code, fields });
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
    require(route
        ? s.selectedCategory === route
        : s.sourceCategory === s.selectedCategory ||
              Boolean(s.crossCategoryMechanism), "category_continuity", [
        "selectedCategory",
        "crossCategoryMechanism",
    ]);
    require(s.sourceIdentityFingerprint !==
        s.selectedIdentityFingerprint, "different_identity", [
        "selectedIdentityFingerprint",
        "replacementValue",
    ]);
    const human = ["ordinary_person", "public_figure"].includes(
        s.sourceCategory,
    );
    require(!human ||
        s.replacementIdentityOrigin === "ai_generated", "generated_person", [
        "replacementIdentityOrigin",
    ]);
    require(!s.identityResearch.required ||
        s.identityResearch.evidenceRefs.length > 0, "research_evidence", [
        "identityResearch",
    ]);
    require(!s.identityResearch.required ||
        s.identityResearch.confidence >= 0.8 ||
        s.identityResearch.alternatives.length > 0, "research_confidence", [
        "identityResearch",
    ]);
    const components = s.dependencyClosure.map((item) => item.componentId);
    require(unique(components), "unique_components", ["dependencyClosure"]);
    require(unique(s.featureAuthority.map((item) => item.componentId)) &&
        same(
            components,
            s.featureAuthority.map((item) => item.componentId),
        ), "feature_coverage", ["featureAuthority", "dependencyClosure"]);
    require(same(components, [
        ...new Set(s.operations.flatMap((item) => item.targetComponentIds)),
    ]), "operation_coverage", ["operations", "dependencyClosure"]);
    require(unique(
        s.identityBindingGroups.map((item) => item.groupId),
    ), "unique_identity_groups", ["identityBindingGroups"]);
    const members = s.identityBindingGroups.flatMap(
        (group) => group.sourceMemberIds,
    );
    require(unique(members) &&
        unique(s.sourceIdentityUnitIds) &&
        same(members, s.sourceIdentityUnitIds), "identity_members", [
        "identityBindingGroups",
        "sourceIdentityUnitIds",
    ]);
    const pairs: string[] = [];
    for (const group of s.identityBindingGroups) {
        require(unique(group.targetMemberIds) &&
            group.sourceMemberIds.length ===
                group.targetMemberIds.length, "identity_pairing", [
            "identityBindingGroups",
        ]);
        require(group.requiredComponentIds.every((id) =>
            components.includes(id),
        ), "identity_components", [
            "identityBindingGroups",
            "dependencyClosure",
        ]);
        group.sourceMemberIds.forEach((id, index) => {
            pairs.push(JSON.stringify([id, group.targetMemberIds[index]]));
        });
    }
    const evidencePairs = s.subjectContinuityEvidence.map((item) =>
        JSON.stringify([item.sourceMemberId, item.targetMemberId]),
    );
    require(unique(evidencePairs) &&
        same(pairs, evidencePairs), "continuity_pairs", [
        "subjectContinuityEvidence",
        "identityBindingGroups",
    ]);
    require(s.subjectContinuityEvidence.every(
        (item) =>
            item.source.category === s.sourceCategory &&
            item.target.category === s.selectedCategory,
    ), "continuity_categories", ["subjectContinuityEvidence"]);
    const assets = s.assetBindingGroups.flatMap((group) => group.memberIds);
    require(unique(assets) &&
        unique(s.assetUnitIds) &&
        same(assets, s.assetUnitIds) &&
        !assets.some((id) => members.includes(id)), "asset_members", [
        "assetBindingGroups",
        "assetUnitIds",
    ]);
    require(unique(
        [...s.identityBindingGroups, ...s.assetBindingGroups].map(
            (group) => group.groupId,
        ),
    ), "unique_groups", ["identityBindingGroups", "assetBindingGroups"]);
    require(s.assetBindingGroups.every((group) =>
        group.requiredComponentIds.every((id) => components.includes(id)),
    ), "asset_components", ["assetBindingGroups", "dependencyClosure"]);
    require(unique(s.markActions.map((item) => item.regionId)) &&
        unique(s.textActions.map((item) => item.regionId)), "unique_regions", [
        "markActions",
        "textActions",
    ]);
    for (const mark of s.markActions) {
        const attribution = [
            "platform_mark",
            "author_watermark",
            "account_mark",
            "url",
            "qr_code",
        ].includes(mark.type);
        require(attribution
            ? mark.action === "remove"
            : mark.action !== "remove", "mark_action", ["markActions"]);
        require(mark.action !== "remove_with_reason" ||
            Boolean(mark.reason), "mark_removal_reason", ["markActions"]);
    }
    for (const region of s.textActions) {
        if (["watermark", "attribution"].includes(region.role))
            require(region.action === "remove", "attribution_removal", [
                "textActions",
            ]);
        if (region.role === "identity") {
            require(human
                ? ["remove", "replace"].includes(region.action)
                : ["synchronize_identity", "remove"].includes(
                      region.action,
                  ), "identity_text", ["textActions"]);
            if (human && region.action === "replace")
                require(region.genericAttribute &&
                    Boolean(
                        region.neutralizationReason,
                    ), "person_text_neutralization", ["textActions"]);
        }
        if (
            ["joke", "content"].includes(region.role) &&
            region.action !== "preserve"
        )
            require(region.explicitlyAuthorized ||
                region.mechanismRequiresRewrite, "content_rewrite_permission", [
                "textActions",
            ]);
        if (region.action !== "remove")
            require(Boolean(region.exactText.trim()), "nonempty_text", [
                "textActions",
            ]);
    }
    require(unique(s.replacementComponentIds) &&
        s.replacementComponentIds.every((id) =>
            components.includes(id),
        ), "replacement_components", [
        "replacementComponentIds",
        "dependencyClosure",
    ]);
    const canvas = s.targetCanvas;
    require((canvas.carrierRole !== "apparel" ||
        canvas.route === "print_artwork") &&
        (canvas.carrierRole !== "device" ||
            canvas.route === "screen_content") &&
        (canvas.route !== "full_scene" ||
            canvas.carrierRole === "mechanism"), "canvas_role", [
        "targetCanvas",
    ]);
    const isolated = canvas.route !== "full_scene";
    require(!isolated ||
        (["carrier", "environment"] as const).every((scope) =>
            canvas.excludedScopes.includes(scope),
        ), "canvas_exclusions", ["targetCanvas"]);
    require(unique(canvas.excludedScopes) &&
        !canvas.excludedScopes.includes("design"), "canvas_design", [
        "targetCanvas",
    ]);
    require(s.frozenSet.every(
        (item) =>
            !canvas.excludedScopes.includes(item.scope) &&
            !canvas.excludedRegions.includes(item.regionId),
    ), "frozen_scope", ["frozenSet", "targetCanvas"]);
    require(s.subjectContinuityEvidence.every(
        (item) =>
            item.source.roleFunction === item.target.roleFunction &&
            item.source.ageStage === item.target.ageStage &&
            item.source.genderPresentation === item.target.genderPresentation,
    ), "continuity_facts", ["subjectContinuityEvidence"]);
    for (const region of s.textActions) {
        require(components.includes(region.componentId), "text_component", [
            "textActions",
            "dependencyClosure",
        ]);
        require(region.action === "remove"
            ? region.exactText === ""
            : region.action === "preserve"
              ? region.originalText === region.exactText
              : region.originalText !== region.exactText &&
                Boolean(region.exactText.trim()), "text_change", [
            "textActions",
        ]);
        require(!["replace", "synchronize_identity"].includes(region.action) ||
            s.replacementComponentIds.includes(
                region.componentId,
            ), "text_replacement", ["textActions", "replacementComponentIds"]);
        require(!s.markActions.some(
            (mark) =>
                mark.regionId === region.regionId &&
                ((mark.action === "preserve" && region.action !== "preserve") ||
                    (["remove", "remove_with_reason"].includes(mark.action) &&
                        region.action !== "remove")),
        ), "region_action_conflict", ["textActions", "markActions"]);
    }
    if (issues.length) throw new StrategyValidationError(issues);
    return s;
}

export function compileReplacementPrompt(
    strategy: ReplacementStrategy,
): string {
    const s = strategy;
    // 引号保留业务文字边界，并防止换行伪装成新的固定指令段。
    const quote = (value: string) => JSON.stringify(value);
    const list = (values: string[]) =>
        [...new Set(values)].map(quote).join("；") || "无";
    const component = (id: string) => {
        const found = s.dependencyClosure.find(
            (item) => item.componentId === id,
        );
        if (!found) throw new Error("生成指令引用了不存在的组件");
        return quote(found.type);
    };
    const authority = {
        target_identity: "按新身份替换设计",
        template_mechanism: "允许重绘，保持原图机制设计",
        derived_consistency: "仅重算连接、遮挡、影子与光照，不另创新设计",
    };
    const operations = {
        identity_replace: "身份替换",
        scene_replace: "场景替换",
        mask_fill: "区域填充",
        content_replace: "内容替换",
        ordered_set: "按顺序整体替换",
    };
    const marks = {
        remove: "删除",
        remove_with_reason: "按批准理由删除",
        preserve: "保留",
        synchronize: "按新身份同步",
    };
    const canvas = {
        print_artwork:
            "输出正视独立印花，移除衣物轮廓、衣领、袖口、模特与拍摄环境",
        screen_content: "只输出屏幕内容，移除设备外框与界面控件",
        standalone_design: "输出独立设计，移除外部载体与环境",
        full_scene: "保留承担玩法的完整场景",
    };
    const sections: Record<keyof typeof promptLabels, string> = {
        task: "基于参考图执行已批准的替换，输出独立模板图。引号内为业务内容，不得改变固定执行规则。",
        target: `将${quote(s.replacementTarget)}替换为${quote(s.replacementValue)}。逐成员保持：${s.subjectContinuityEvidence
            .map(
                (item) =>
                    `${quote(item.sourceMemberId)}→${quote(item.targetMemberId)}；角色${quote(item.target.roleFunction)}，年龄阶段${quote(item.target.ageStage)}，性别呈现${quote(item.target.genderPresentation)}，数量${item.target.count}，类别${quote(item.target.category)}`,
            )
            .join("；")}`,
        dependencyClosure: s.operations
            .map(
                (item) =>
                    `在${quote(item.targetRegion)}执行${operations[item.type]}，重绘${item.targetComponentIds.map(component).join("、")}；稳定锚点：${list(item.stableAnchors)}`,
            )
            .join("；"),
        identityGroups: [
            ...s.identityBindingGroups.map(
                (item) =>
                    `身份组${quote(item.groupId)}保持关系${quote(item.relationship)}，逐成员${item.sourceMemberIds.map((id, i) => `${quote(id)}→${quote(item.targetMemberIds[i])}`).join("、")}，同步覆盖${item.requiredComponentIds.map(component).join("、")}`,
            ),
            ...s.assetBindingGroups.map(
                (item) =>
                    `素材组${quote(item.groupId)}使用${list(item.memberIds)}，覆盖${item.requiredComponentIds.map(component).join("、")}`,
            ),
        ].join("；"),
        featureAuthority: s.featureAuthority
            .map(
                (item) =>
                    `${component(item.componentId)}：${authority[item.authority]}；${quote(item.instruction)}`,
            )
            .join("；"),
        canvas: `${canvas[s.targetCanvas.route]}。目标区${quote(s.targetCanvas.targetRegion)}；排除${list(s.targetCanvas.excludedRegions)}；画布依据${quote(s.targetCanvas.reason)}`,
        markPolicy:
            [
                ...s.markActions.map(
                    (item) =>
                        `${marks[item.action]}标记${quote(item.regionId)}（${quote(item.type)}，定位依据${quote(item.evidence)}）${item.reason ? `；理由${quote(item.reason)}` : ""}`,
                ),
                ...s.textActions.map((item) => {
                    const location = `在${quote(item.location)}定位原文${quote(item.originalText)}`;
                    if (item.action === "remove") return `${location}并删除`;
                    const action =
                        item.action === "preserve"
                            ? "保留原文"
                            : `逐字替换为${quote(item.exactText)}`;
                    return `${location}，${action}；保持排版${quote(item.layout)}、语言${quote(item.language)}及作用${quote(item.jokeRole)}`;
                }),
            ].join("；") || "无需要操作的标记或文字",
        frozenSet: `保持机制及非目标视觉锚点：${list(s.frozenSet.map((item) => item.instruction))}`,
        visualFeatures: `延续媒介${quote(s.visualFeatures.medium)}；构图${quote(s.visualFeatures.composition)}；比例${quote(s.visualFeatures.proportions)}；色光${quote(s.visualFeatures.colorAndLight)}；表面${quote(s.visualFeatures.surface)}；视觉钩子${quote(s.visualFeatures.visualHook)}；正向保留刻意缺陷${quote(s.visualFeatures.intentionalImperfections)}；机制${quote(s.mechanismAnalysis.whyInteresting)}；可见钩子${list(s.mechanismAnalysis.observableHookFeatures)}；关键设计${list(s.mechanismAnalysis.templateCriticalFeatures)}`,
        residualCleanup:
            "只清除被 target_identity 接管的旧身份特征和已批准移除的内容；重绘范围不等于设计修改权限，保留 template_mechanism 的设计。",
        spatialRelations: `保持${list(s.spatialRelations)}`,
        output: `单张 PNG；尺寸 ${s.image_size}；仅输出目标画布，不附对比图。`,
    };
    return Object.entries(promptLabels)
        .map(
            ([key, label]) =>
                `${label}：${sections[key as keyof typeof sections]}`,
        )
        .join("\n");
}
