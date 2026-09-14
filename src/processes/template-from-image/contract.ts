/** 校验固定 Gallery Schema、槽位绑定和开放值，投影由服务端拥有的草稿字段。 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { z } from "zod";
import { isPublicSourceImageUrl } from "../crt/capability.js";
import {
    type TemplateValidationDiagnostic,
    validationDiagnostics,
} from "./diagnostics.js";
import { type TemplateImage, templateImageSize } from "./image.js";
import {
    analysisIssues,
    reviewIssues,
    type TemplateCandidate,
    templateAnalysisSchema,
} from "./quality.js";
import { templateSchemaSha256, templateSchemaUrl } from "./skills.js";

export { reviewAxes, templateReviewSchema } from "./quality.js";

import type { Template, TemplateDraft } from "./types.js";

export const templateInputSchema = z.strictObject({
    imageUrl: z
        .string()
        .min(1)
        .max(2_048)
        .refine(isPublicSourceImageUrl, "图片地址必须是公网 HTTPS URL"),
    note: z.string().trim().min(1).max(500).optional(),
});

const schemaBytes = readFileSync(templateSchemaUrl);
if (
    createHash("sha256").update(schemaBytes).digest("hex") !==
    templateSchemaSha256
) {
    throw new Error("模板 Gallery Schema 摘要不匹配");
}
const schema = JSON.parse(schemaBytes.toString("utf8"));
const draftFields = [
    "key",
    "title",
    "description",
    "promptTemplate",
    "inputSchema",
    "runtimeSemantics",
    "metadata",
];
export const templateDraftJsonSchema = {
    ...schema,
    $id: "urn:pipipi:template-from-image:draft:v1",
    required: draftFields,
    properties: {
        ...Object.fromEntries(
            draftFields.map((field) => [field, schema.properties[field]]),
        ),
        title: { ...schema.properties.title, maxLength: 20 },
        description: { ...schema.properties.description, maxLength: 20 },
        inputSchema: {
            ...schema.properties.inputSchema,
            type: "object",
            required: ["version", "slots"],
            properties: {
                version: { const: 2 },
                slots: {
                    type: "array",
                    minItems: 1,
                    maxItems: 4,
                    items: {
                        type: "object",
                        required: ["text"],
                        properties: {
                            text: {
                                type: "object",
                                required: [
                                    "presentation",
                                    "allowCustom",
                                    "defaultValue",
                                    "placeholder",
                                    "suggestions",
                                ],
                                properties: {
                                    presentation: { const: "suggestions" },
                                    allowCustom: { const: true },
                                    suggestions: {
                                        minItems: 3,
                                        maxItems: 3,
                                        uniqueItems: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};
const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    formats: { uri: fullFormats.uri },
});
const validateDraft = ajv.compile<TemplateDraft>(templateDraftJsonSchema);
const outputContract = {
    ...schema,
    required: [
        ...new Set([
            ...schema.required,
            ...draftFields,
            "kind",
            "imageN",
            "preprocessSteps",
        ]),
    ],
};
const validateTemplate = ajv.compile<Template>(outputContract);
const majorTags = new Set([
    "人物",
    "动物",
    "二次元",
    "粉丝应援",
    "情侣",
    "亲子家庭",
    "美食",
    "风景建筑",
    "搞怪meme",
    "文字设计",
    "创意艺术",
]);
export const templateCandidateSchema = z.object({
    draft: z.unknown(),
    analysis: templateAnalysisSchema,
});

export function parseTemplateCandidate(value: unknown): TemplateCandidate {
    const candidate = readTemplateCandidate(value);
    const issues = [
        ...templateSemanticIssues(candidate.draft),
        ...analysisIssues(candidate),
    ];
    if (issues.length) throw new TemplateContractError(issues);
    return candidate;
}

/** 只校验候选结构，草稿语义、分析一致性与独立复核问题合并处理。 */
export function readTemplateCandidate(value: unknown): TemplateCandidate {
    const parsed = templateCandidateSchema.safeParse(value);
    if (!parsed.success)
        throw new TemplateContractError(
            parsed.error.issues
                .slice(0, 16)
                .map(
                    (issue) =>
                        `analysis: ${issue.path.join(".")} ${issue.message}`,
                ),
            validationDiagnostics(parsed.error.issues),
        );
    const draft = readTemplateDraft(parsed.data.draft);
    return { draft, analysis: parsed.data.analysis };
}

export class TemplateContractError extends Error {
    constructor(
        readonly issues: readonly string[],
        readonly diagnostics: readonly TemplateValidationDiagnostic[] = [],
    ) {
        super("模板候选未通过校验");
    }
}

export function parseTemplateDraft(value: unknown): TemplateDraft {
    const draft = readTemplateDraft(value);
    const issues = templateSemanticIssues(draft);
    if (issues.length) throw new TemplateContractError(issues);
    return draft;
}

export function readTemplateDraft(value: unknown): TemplateDraft {
    if (!validateDraft(value)) {
        // 缺失属性来自固定 Schema，明确字段名才能修正；仍不回显原始字段值或远端错误。
        throw new TemplateContractError(
            (validateDraft.errors ?? [])
                .slice(0, 12)
                .map(
                    (issue) =>
                        `${issue.instancePath || "/"}: ${issue.keyword}${issue.keyword === "required" ? ` ${issue.params.missingProperty}` : ""}`,
                ),
            validationDiagnostics(
                (validateDraft.errors ?? []).map((issue) => ({
                    path: [
                        "draft",
                        ...issue.instancePath
                            .split("/")
                            .filter(Boolean)
                            .map((part) =>
                                /^\d+$/.test(part) ? Number(part) : part,
                            ),
                        ...(issue.keyword === "required"
                            ? [issue.params.missingProperty]
                            : []),
                    ],
                    code: issue.keyword,
                })),
            ),
        );
    }
    return value;
}

export function templateSemanticIssues(draft: TemplateDraft): string[] {
    const issues: string[] = [];
    const check = (condition: boolean, message: string) => {
        if (!condition && issues.length < 16) issues.push(message);
    };
    const { slots } = draft.inputSchema;
    const {
        targetInstances: targets,
        inputBindings: bindings,
        visualContract,
    } = draft.runtimeSemantics;
    check(
        draft.runtimeSemantics.version === 2,
        "runtimeSemantics.version 必须为 2",
    );
    check([...draft.title].length <= 20, "title 最多 20 字");
    check([...draft.description].length <= 20, "description 最多 20 字");
    check(slots.length <= 4, "最多四个编辑槽位");
    const tags = draft.metadata.tags;
    check(
        tags.length >= 5 &&
            tags.length <= 8 &&
            tags.every((tag) => [...tag].length <= 12),
        "标签为 5–8 项，每项最多 12 字",
    );
    check(
        tags.some((tag) => majorTags.has(tag)),
        "标签至少包含一个正式大类",
    );
    check(
        Object.keys(draft.metadata).every((key) => key === "tags"),
        "metadata 只能包含 tags；不要写入 needsReview 等复核状态",
    );
    const ids = slots.map((slot) => slot.id);
    check(new Set(ids).size === ids.length, "槽位 ID 不能重复");
    check(
        sameSet(ids, Object.keys(bindings)),
        "每个槽位必须且只能有一个 binding",
    );
    const targetIds = targets.map((target) => target.id);
    check(new Set(targetIds).size === targetIds.length, "target ID 不能重复");
    const occupied = new Set<string>();
    const placeholders = [
        ...draft.promptTemplate.matchAll(
            /\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\|\s*("(?:[^"\\]|\\.)*")\s*\}\}/gu,
        ),
    ];
    check(
        placeholders.length === ids.length &&
            sameSet(
                ids,
                placeholders.map((match) => match[1]),
            ),
        "每个槽位必须恰好出现一次带默认值的占位符",
    );
    let prose = draft.promptTemplate;
    for (const match of placeholders) prose = prose.replace(match[0], "");
    check(
        !prose.includes("{{") && !prose.includes("}}"),
        "Prompt 存在无效占位符",
    );
    check(
        !/runtimeSemantics|visualContract|inputBindings|targetInstances|clothingOwnership|上传图中|从零完整重绘|后端合同|槽位/u.test(
            draft.promptTemplate,
        ),
        "前台 Prompt 不应包含编译术语",
    );
    const fixedText = JSON.stringify({
        targets,
        visualContract,
        title: draft.title,
        tags,
    });
    for (const slot of slots) {
        check(
            slot.required === false && Boolean(slot.text),
            `${slot.id}: 必须可选且支持文字`,
        );
        if (!slot.text) continue;
        const placeholder = placeholders.find((match) => match[1] === slot.id);
        if (placeholder)
            check(
                JSON.parse(placeholder[2]) === slot.text.defaultValue,
                `${slot.id}: fallback 必须等于默认值`,
            );
        check(
            !fixedText.includes(slot.text.defaultValue),
            `${slot.id}: 开放默认值不能写入固定约束或发现文案`,
        );
        const values = [slot.text.defaultValue, ...slot.text.suggestions];
        check(values.every(isQuickText), `${slot.id}: 默认值或推荐文字过长`);
        check(
            slot.text.suggestions.every(
                (value) => !value.includes("{{") && !value.includes("}}"),
            ),
            `${slot.id}: 推荐项不能包含占位符`,
        );
        const binding = bindings[slot.id];
        if (!binding) continue;
        const selected = binding.targetIds.map((id) =>
            targets.find((target) => target.id === id),
        );
        check(selected.every(Boolean), `${slot.id}: binding 指向未知 target`);
        if (slot.image) {
            check(
                slot.image.minWidth === 256 &&
                    slot.image.minHeight === 256 &&
                    sameSet(slot.image.sourceOptions, [
                        "upload",
                        "recent_upload",
                        "asset_library",
                    ]),
                `${slot.id}: 图片输入配置不符合固定合同`,
            );
        }
        if (binding.operation === "replace_identity") {
            check(Boolean(slot.image), `${slot.id}: 身份替换必须支持图片输入`);
            check(
                binding.clothingOwnership === "source" ||
                    binding.clothingOwnership === "template",
                `${slot.id}: 缺少服装归属`,
            );
            check(
                slot.image?.private === true,
                `${slot.id}: 身份输入必须标记为私有`,
            );
            const kind =
                binding.bindingPolicy === "preserve_group"
                    ? "identity_group"
                    : "identity_subject";
            check(
                selected.every((target) => target?.kind === kind),
                `${slot.id}: 身份策略与目标类型不匹配`,
            );
            for (const target of binding.targetIds) {
                check(
                    !occupied.has(target),
                    `${slot.id}: 同一身份目标不能被多个输入占用`,
                );
                occupied.add(target);
            }
        } else {
            check(
                selected.every((target) => target?.kind === "content_element"),
                `${slot.id}: 内容输入必须绑定内容目标`,
            );
        }
    }
    for (const target of targets) {
        if (target.kind === "identity_group")
            check(
                (target.minMembers ?? 0) >= 2 &&
                    (target.maxMembers ?? 0) >= (target.minMembers ?? 0),
                `${target.id}: 群组人数范围必须为 2–20 且有序`,
            );
        if (target.kind !== "content_element")
            check(
                occupied.has(target.id),
                `${target.id}: 身份目标缺少输入绑定`,
            );
    }
    return issues;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
    return (
        left.length === right.length &&
        new Set(left).size === left.length &&
        left.every((value) => right.includes(value))
    );
}

function isQuickText(value: string): boolean {
    const words = value.trim().split(/\s+/u);
    return words.length > 1
        ? words.length <= 7 && [...value].length <= 48
        : [...value].length <= 20;
}

export function compileTemplateResult(
    value: unknown,
    imageUrl: string,
    image: TemplateImage,
): Template {
    const candidate = readTemplateCandidate(value);
    const review =
        value && typeof value === "object" && "review" in value
            ? value.review
            : undefined;
    const issues = [
        ...templateSemanticIssues(candidate.draft),
        ...analysisIssues(candidate),
        ...reviewIssues(candidate, review),
    ];
    if (issues.length) throw new TemplateContractError(issues);
    const { draft } = candidate;
    return {
        ...draft,
        status: "DRAFT",
        kind: "PROMPT",
        imageN: 1,
        preprocessSteps: [],
        imageSize: templateImageSize(image),
        cover: imageUrl,
        referenceImage: imageUrl,
    };
}

export const templateOutputSchema = z.strictObject({
    // 目录描述复用同一个固定合同；实际解析仍以 Ajv 和业务语义校验为准。
    template: z
        .unknown()
        .refine(
            (value) =>
                validateTemplate(value) &&
                templateSemanticIssues(value).length === 0,
        )
        .meta(outputContract),
});
