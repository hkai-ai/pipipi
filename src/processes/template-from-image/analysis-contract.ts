/** 承接原 Skill 的独立观察、文字路由和语义证据合同，不推断视觉结论。 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { TemplateCandidate } from "./quality.js";

const text = z.string().trim().min(1);
const texts = z.array(text);
export const evidenceFields = [
    "key",
    "title",
    "description",
    "tags",
    "imageSize",
    "slots",
    "suggestions",
    "defaults",
    "text",
    "subjectsAndIdentityBindings",
    "promptTemplate",
    "visualContract",
    "inputBindings",
    "clothingOwnership",
    "cover",
    "referenceImage",
] as const;
export const editValues = {
    open_slot: "high",
    free_editable: "secondary",
    preserve: "fixed",
    remove: "none",
    review: "ambiguous",
} as const;
export const textRegionSchema = z.strictObject({
    id: text,
    componentId: text,
    role: z.enum([
        "identity",
        "content",
        "attribution",
        "watermark",
        "brand",
        "ambiguous",
    ]),
    semanticUnitId: text,
    semanticUnitRole: z.enum([
        "independent_message",
        "distributed_message",
        "supporting_copy",
        "fixed_context",
        "noise",
        "ambiguous",
    ]),
    language: text,
    exactText: text,
    layout: text.describe(
        "独立记录可见排版：整段或整行的排列形态、各部分相对位置，再描述单个字形和字间关系。若输入提供 pixelContours，对照图中该区和分段上下缘，比较位置变化；阅读方向水平不代表所有部分高度相同，整体关系与局部笔画分别说明。像素边缘不等于字体基线，按图判断，不预设形状或凑固定条数",
    ),
    position: text,
    action: z.enum([
        "open_slot",
        "free_editable",
        "preserve",
        "remove",
        "review",
    ]),
    editValue: z
        .enum(["high", "secondary", "fixed", "none", "ambiguous"])
        .describe(
            "按原 Skill 的动作映射填写：open_slot=high、free_editable=secondary、preserve=fixed、remove=none、review=ambiguous；不按主副标题的视觉层级填写",
        ),
    slotId: text.nullable(),
    routingEvidence: text,
    translationSourceRegionId: text.nullable(),
});
export const observationShape = {
    imageObservation: z
        .string()
        .trim()
        .min(1)
        .max(8000)
        .describe(
            "本轮首先独立看图形成的原始观察记录：说明视觉机制，逐一观察组件与文字区域，记录可辨原文、整组排列及各部分相对位置，再描述局部字形、间距和媒介细节。有 pixelContours 时核对同一内容带不同位置的上下边缘变化；记录重制需保持的关系及不确定性。此时不设计槽位、不编译草稿、不沿用候选结论；后续编译据此取舍，不能先编译再回填观察",
        ),
    visualMechanism: text,
    containers: z.array(z.record(z.string(), z.json())),
    fixedStructure: texts.min(1),
    fieldEvidence: z
        .record(z.enum(evidenceFields), texts.min(1))
        .describe(
            "按原 Skill 保留原始依据。visualContract 逐项记录对重制视觉有影响的具体观察，也保留不冻结的外观；结合组件、文字布局、媒介和空间关系检查遗漏。这里只记图中所见，后续 visualSelections 决定取舍，不能从已写的正式约束倒推依据",
        ),
    promptCoverage: z.strictObject({
        allEditableContentCovered: z.boolean(),
        slotIds: texts,
        freeEditableRegionIds: texts,
    }),
    translationEquivalences: z.array(
        z.strictObject({
            sourceRegionId: text,
            targetRegionIds: texts.min(1),
            sourceTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
            targetTextSha256: z.record(
                z.string(),
                z.string().regex(/^[a-f0-9]{64}$/),
            ),
        }),
    ),
    warnings: texts,
};
export const semanticEvidenceShape = {
    dynamicFactSources: z
        .record(z.string(), text)
        .describe(
            '准确覆盖全部正式槽位：每项为 "槽位id": "inputSchema.slots.槽位id"；键不是目标或视觉事实名，值不是裸槽位 id',
        ),
    completeRedrawByTarget: z
        .record(z.string(), z.boolean())
        .describe(
            "只覆盖 replace_identity 绑定的 targetIds，各值为 true；replace_content 等其他操作的目标不在此表中。没有身份替换时返回空对象，不把文字内容重绘当作身份重绘",
        ),
    sourceIsolationByInput: z.record(z.string(), z.boolean()),
};
export const slotEvidenceShape = {
    defaultLanguageReview: z.strictObject({
        natural: z.boolean(),
        concise: z.boolean(),
        modifierMinimal: z.boolean(),
    }),
    inputModeDecision: z.strictObject({
        modes: z.array(z.enum(["text", "image"])).min(1),
        reason: z.enum([
            "identity_subject",
            "dynamic_group",
            "text_only",
            "exact_content_asset",
        ]),
        evidence: text,
    }),
    inheritFromUpload: texts,
    keepFromTemplate: texts,
    sourceIsolation: z.boolean().nullable(),
};
export const suggestionChecksShape = {
    sameAxis: z.boolean(),
    sameGranularity: z.boolean(),
    mechanismCompatible: z.boolean(),
};

/** 数量由独立身份、可见实例和正式控件各自导出，不把它们视为同一数量。 */
export function analysisCounts({
    analysis,
    draft,
}: {
    analysis: Pick<TemplateCandidate["analysis"], "identityTopology">;
    draft: TemplateCandidate["draft"];
}) {
    return {
        identityCount: analysis.identityTopology.length,
        visualInstanceCount: new Set(
            analysis.identityTopology.flatMap((unit) => unit.instanceIds),
        ).size,
        uploadAssetCount: draft.inputSchema.slots.filter((slot) => slot.image)
            .length,
        inputControlCount: draft.inputSchema.slots.length,
    };
}

export function sourceContractIssues({
    analysis: a,
    draft,
}: TemplateCandidate): string[] {
    const issues: string[] = [];
    const check = (ok: boolean, message: string) => {
        if (!ok) issues.push(message);
    };
    const sameKeys = (record: object, keys: string[]) =>
        isDeepStrictEqual(
            Object.keys(record).sort(),
            [...new Set(keys)].sort(),
        );
    const slots = draft.inputSchema.slots;
    const bindings = draft.runtimeSemantics.inputBindings;
    const model = a.semanticModel;
    check(
        Object.values(a.titleEvidence).every((gate) => gate.passed),
        "titleEvidence: 标题未通过全部发现门禁",
    );
    check(
        Object.values(a.descriptionEvidence).every((gate) => gate.passed),
        "descriptionEvidence: 简介未通过全部文案门禁",
    );
    check(
        isDeepStrictEqual(
            model.dynamicFactSources,
            Object.fromEntries(
                slots.map((slot) => [slot.id, `inputSchema.slots.${slot.id}`]),
            ),
        ),
        "semanticModel.dynamicFactSources: 每个开放值必须有唯一的正式输入来源",
    );
    check(
        sameKeys(
            model.sourceIsolationByInput,
            slots.filter((slot) => slot.image).map((slot) => slot.id),
        ) &&
            Object.values(model.sourceIsolationByInput).every(
                (value) => value === true,
            ),
        "semanticModel.sourceIsolationByInput: 图片输入必须逐项确认来源隔离",
    );
    const identityTargets = Object.values(bindings)
        .filter((binding) => binding.operation === "replace_identity")
        .flatMap((binding) => binding.targetIds);
    check(
        sameKeys(model.completeRedrawByTarget, identityTargets) &&
            Object.values(model.completeRedrawByTarget).every(
                (value) => value === true,
            ),
        "semanticModel.completeRedrawByTarget: 完整重绘必须准确覆盖身份目标",
    );
    check(
        a.promptCoverage.allEditableContentCovered &&
            isDeepStrictEqual(
                [...a.promptCoverage.slotIds].sort(),
                slots.map((slot) => slot.id).sort(),
            ),
        "promptCoverage.slotIds: Prompt 必须覆盖全部编辑槽位",
    );
    check(
        isDeepStrictEqual(
            [...a.promptCoverage.freeEditableRegionIds].sort(),
            a.textRegions
                .filter((region) => region.action === "free_editable")
                .map((region) => region.id)
                .sort(),
        ),
        "promptCoverage.freeEditableRegionIds: 自由编辑区域覆盖不一致",
    );
    for (const region of a.textRegions) {
        check(
            region.editValue === editValues[region.action],
            "textRegions.editValue: 文字价值与路由不一致",
        );
        check(
            region.role !== "watermark" || region.action === "remove",
            "textRegions.role: 水印必须删除",
        );
        check(
            region.role !== "ambiguous" || region.action === "review",
            "textRegions.role: 歧义文字必须待辨识",
        );
        check(
            !identityTargets.length ||
                region.role !== "identity" ||
                region.action !== "preserve",
            "textRegions.role: 开放身份不能保留原身份文字",
        );
    }
    const byId = new Map(a.textRegions.map((region) => [region.id, region]));
    const covered = new Set<string>();
    const sha = (value: string) =>
        createHash("sha256").update(value).digest("hex");
    for (const entry of a.translationEquivalences) {
        const source = byId.get(entry.sourceRegionId);
        const targets = entry.targetRegionIds.map((id) => byId.get(id));
        check(
            Boolean(source) &&
                targets.every(Boolean) &&
                new Set(entry.targetRegionIds).size === targets.length,
            "translationEquivalences: 引用了未知或重复文字区",
        );
        if (!source || targets.some((target) => !target)) continue;
        check(
            entry.sourceTextSha256 === sha(source.exactText) &&
                isDeepStrictEqual(
                    entry.targetTextSha256,
                    Object.fromEntries(
                        targets
                            .filter((target) => target !== undefined)
                            .map((target) => [
                                target.id,
                                sha(target.exactText),
                            ]),
                    ),
                ),
            "translationEquivalences: 原文摘要已失效",
        );
        for (const target of targets) {
            if (!target) continue;
            covered.add(target.id);
            check(
                target.translationSourceRegionId === source.id,
                "translationEquivalences: 翻译来源关联不一致",
            );
        }
    }
    check(
        isDeepStrictEqual(
            [...covered].sort(),
            a.textRegions
                .filter((region) => region.translationSourceRegionId !== null)
                .map((region) => region.id)
                .sort(),
        ),
        "translationEquivalences: 声明的翻译区域缺少准确证据",
    );
    for (const slot of slots) {
        const evidence = a.slotEvidence[slot.id];
        const binding = bindings[slot.id];
        if (!evidence || !binding) continue;
        const identity = evidence.identityRecognition;
        if (
            binding.operation === "replace_identity" &&
            binding.bindingPolicy !== "preserve_group"
        ) {
            check(
                identity !== null &&
                    (identity.status === "recognized"
                        ? identity.name === slot.text.defaultValue &&
                          !["角色", "人物", "主体"].some((suffix) =>
                              identity.name?.endsWith(suffix),
                          )
                        : identity.name === null),
                "slotEvidence.identityRecognition: 未识别身份不声明专名，识别身份须具体且匹配默认值",
            );
        } else
            check(
                identity === null,
                "slotEvidence.identityRecognition: 识别记录仅用于可寻址身份槽位",
            );
        const values = [slot.text.defaultValue, ...slot.text.suggestions];
        if (
            a.textRegions.some(
                (region) =>
                    region.action === "open_slot" && region.slotId === slot.id,
            )
        )
            check(
                values.every((value) => {
                    const normalized = value.trim();
                    return /\s/u.test(normalized)
                        ? normalized.split(/\s+/u).length <= 7 &&
                              [...normalized].length <= 48
                        : [...normalized].length <= 20;
                }),
                "textRegions: 快速文字默认值或推荐文字过长",
            );
        const scripts = (value: string) =>
            [
                /[A-Za-z]/u,
                /[\u4e00-\u9fff]/u,
                /[\u3040-\u30ff]/u,
                /[\uac00-\ud7af]/u,
            ].flatMap((pattern, index) => (pattern.test(value) ? [index] : []));
        const base = scripts(slot.text.defaultValue);
        check(
            slot.text.suggestions.every((value) => {
                const other = scripts(value);
                return (
                    !base.length ||
                    !other.length ||
                    base.some((script) => other.includes(script)) ||
                    (base.includes(1) && other.includes(2)) ||
                    (base.includes(2) && other.includes(1))
                );
            }),
            "slotEvidence.substitutions: 推荐项语言脚本与默认值不兼容",
        );
        check(
            Object.values(evidence.defaultLanguageReview).every(
                (value) => value === true,
            ),
            "slotEvidence.defaultLanguageReview: 默认文案未通过自然语言复核",
        );
        const mode = evidence.inputModeDecision;
        const expectedReason = slot.image
            ? binding.operation === "replace_identity"
                ? binding.bindingPolicy === "preserve_group"
                    ? "dynamic_group"
                    : "identity_subject"
                : "exact_content_asset"
            : "text_only";
        check(
            isDeepStrictEqual(
                mode.modes,
                slot.image ? ["text", "image"] : ["text"],
            ) && mode.reason === expectedReason,
            "slotEvidence.inputModeDecision: 输入方式与实际能力不一致",
        );
        check(
            !slot.image ||
                binding.operation === "replace_identity" ||
                evidence.selectionReason === "exact_content_asset",
            "slotEvidence.selectionReason: 内容图片需要精确素材依据",
        );
        check(
            [slot.text.defaultValue, ...slot.text.suggestions].every((value) =>
                evidence.openVisualFacts.includes(value),
            ),
            "slotEvidence.openVisualFacts: 缺少默认值或推荐值",
        );
        for (const item of evidence.substitutions)
            check(
                item.sameAxis &&
                    item.sameGranularity &&
                    item.mechanismCompatible,
                "slotEvidence.substitutions: 推荐项未通过语义代入检查",
            );
        if (slot.image && binding.operation === "replace_identity") {
            check(
                evidence.sourceIsolation === true &&
                    evidence.inheritFromUpload.length > 0 &&
                    !evidence.inheritFromUpload.some((fact) =>
                        evidence.keepFromTemplate.includes(fact),
                    ),
                "slotEvidence.sourceIsolation: 身份继承与模板保留必须隔离且不冲突",
            );
        }
    }
    return issues;
}
