/** 固定运行语义 v4 作者合同并校验拆解数据、默认值与输入绑定，展示提示词由服务端投影。 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { z } from "zod";
import { type TemplateImage, templateImageSize } from "../image.js";
import { checkDesignSpec } from "./vendor/checks.js";
import {
    type DesignSpec,
    designSpecSchema,
} from "./vendor/design-spec-schema.js";

export const skillRef = Object.freeze({
    name: "print-design-template-compiler",
    version: "v1",
    sha256: "9dcdef9ab32d2c4bd690b73094d04dc51707786bf42511c85df2e42bc1e2ed9f",
    path: ".pi/skills/print-design-template-compiler",
});
const bytes = readFileSync(
    new URL(
        "../../../../.pi/skills/print-design-template-compiler/gallery.schema.json",
        import.meta.url,
    ),
);
if (
    createHash("sha256").update(bytes).digest("hex") !==
    "6978f08d5c22e069f54cba77655913c3ac069083bc0e2b01021ec384c5a29833"
)
    throw new Error("印花模板合同摘要不匹配");
const source = JSON.parse(bytes.toString("utf8"));
const fields = [
    "key",
    "title",
    "description",
    "inputSchema",
    "runtimeSemantics",
    "metadata",
];
export const draftJsonSchema = {
    ...source,
    $id: "urn:pipipi:print-design:draft:v1",
    required: fields,
    properties: Object.fromEntries(
        fields.map((field) => [field, source.properties[field]]),
    ),
};
const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    formats: { uri: fullFormats.uri },
});
const validateDraft = ajv.compile(draftJsonSchema);
const validateOutput = ajv.compile({
    ...source,
    $id: "urn:pipipi:print-design:output:v1",
});
const slotText = z.looseObject({
    defaultValue: z.string().min(1).max(120),
    allowCustom: z.literal(true),
});
const textModes = z.discriminatedUnion("presentation", [
    slotText.extend({ presentation: z.literal("free_text") }),
    slotText.extend({
        presentation: z.literal("suggestions"),
        suggestions: z.array(z.string().min(1).max(120)).min(1).max(10),
    }),
]);
const targetIds = z.array(z.string()).min(1);
const bindingSchema = z.discriminatedUnion("operation", [
    z.strictObject({
        operation: z.literal("replace_identity"),
        targetIds,
        bindingPolicy: z.literal("one_to_one"),
        renderingMode: z.literal("illustration_redraw"),
        allowedSourceGrouping: z.array(z.literal("single_subject")).optional(),
        groupToSinglePolicy: z.literal("reject"),
        clothingOwnership: z.enum(["source", "template"]).optional(),
    }),
    z.strictObject({
        operation: z.literal("replace_content"),
        targetIds,
        valueKind: z.enum(["exact_text", "scene_description", "color"]),
        distributionPolicy: z.literal("replace_as_unit"),
    }),
]);
export const draftSchema = z.strictObject({
    key: z.string().regex(/^[a-z][a-z0-9-]{1,59}$/u),
    title: z.string().trim().min(1).max(20),
    description: z.string().trim().min(1).max(20),
    metadata: z.strictObject({
        tags: z.array(z.string().min(1).max(12)).min(5).max(8),
    }),
    inputSchema: z.strictObject({
        version: z.literal(2),
        slots: z
            .array(
                z.looseObject({
                    id: z.string(),
                    label: z.string(),
                    required: z.literal(false),
                    text: textModes,
                    image: z
                        .looseObject({
                            sourceOptions: z
                                .array(
                                    z.enum([
                                        "upload",
                                        "recent_upload",
                                        "asset_library",
                                    ]),
                                )
                                .min(1),
                            maxCount: z.literal(1),
                            private: z.literal(true),
                        })
                        .optional(),
                    resolutionStrategy: z.literal("image_over_text").optional(),
                }),
            )
            .min(1)
            .max(12),
    }),
    runtimeSemantics: z.strictObject({
        version: z.literal(4),
        targetInstances: z
            .array(
                z.looseObject({
                    id: z.string(),
                    kind: z.enum(["identity_subject", "content_element"]),
                    role: z.string(),
                    region: z.string(),
                }),
            )
            .min(1),
        inputBindings: z.record(z.string(), bindingSchema),
        designSpec: designSpecSchema,
    }),
});
export type PrintDesignDraft = z.infer<typeof draftSchema>;
export const candidateSchema = z.strictObject({
    observation: z.strictObject({
        overview: z.string().trim().min(1).max(3000),
        texts: z
            .array(
                z.strictObject({
                    text: z.string().min(1),
                    location: z.string().min(1),
                    elementId: z.string().min(1),
                }),
            )
            .max(40),
        printRisks: z.array(z.string().min(1)).max(20),
    }),
    draft: draftSchema,
});
export type PrintDesignCandidate = z.infer<typeof candidateSchema>;

export class PrintDesignContractError extends Error {
    constructor(readonly issues: readonly string[]) {
        super("印花模板候选未通过校验");
    }
}
export function readCandidate(raw: unknown): PrintDesignCandidate {
    const result = candidateSchema.safeParse(raw);
    if (!result.success)
        throw new PrintDesignContractError(
            result.error.issues.map(
                (issue) => `${issue.path.join(".")}: ${issue.message}`,
            ),
        );
    if (!validateDraft(result.data.draft))
        throw new PrintDesignContractError(
            (validateDraft.errors ?? []).map((issue) =>
                [
                    issue.instancePath,
                    issue.message ?? issue.keyword,
                    issue.params.additionalProperty,
                    issue.params.allowedValue,
                    issue.params.allowedValues?.join(", "),
                ]
                    .filter((value) => value !== undefined)
                    .join(" "),
            ),
        );
    return result.data;
}
export function draftIssues(draft: PrintDesignDraft): string[] {
    const {
        designSpec: spec,
        targetInstances: targets,
        inputBindings: bindings,
    } = draft.runtimeSemantics;
    const issues = [
        ...checkDesignSpec(spec, [{ id: "default", ...spec.defaults }]).errors,
    ];
    const add = (condition: boolean, message: string) => {
        if (!condition) issues.push(message);
    };
    const elements = new Map(
        spec.elements.map((element) => [element.id, element]),
    );
    const colors = new Set(spec.whole.colorRoles.map((role) => role.id));
    const targetMap = new Map(targets.map((target) => [target.id, target]));
    const slots = draft.inputSchema.slots;
    const slotIds = new Set(slots.map((slot) => slot.id));
    add(slotIds.size === slots.length, "输入槽 id 重复");
    add(targetMap.size === targets.length, "目标 id 重复");
    add(
        Object.keys(bindings).length === slots.length &&
            Object.keys(bindings).every((id) => slotIds.has(id)),
        "输入槽与 binding 必须一一对应",
    );
    add(
        slots.filter((slot) => slot.image).length <= 1,
        "当前引擎最多支持一张主体照片",
    );
    for (const target of targets)
        add(
            elements.has(target.id) || colors.has(target.id),
            `targetInstances.${target.id}: 缺少同名元素或配色角色`,
        );
    const occupied = new Set<string>();
    for (const slot of slots) {
        const binding = bindings[slot.id];
        if (!binding) continue;
        add(
            new Set(binding.targetIds).size === binding.targetIds.length,
            `inputBindings.${slot.id}: 目标重复`,
        );
        for (const id of binding.targetIds) {
            const element = elements.get(id);
            const target = targetMap.get(id);
            add(Boolean(target), `inputBindings.${slot.id}: 目标不存在`);
            let expected: string | undefined;
            if (binding.operation === "replace_identity") {
                add(
                    element?.category === "subject" &&
                        target?.kind === "identity_subject",
                    `inputBindings.${slot.id}: 身份只能接管主体`,
                );
                add(
                    Boolean(slot.image) &&
                        slot.resolutionStrategy === "image_over_text" &&
                        binding.bindingPolicy === "one_to_one" &&
                        binding.renderingMode === "illustration_redraw",
                    `inputBindings.${slot.id}: 主体照片绑定不完整`,
                );
                add(
                    !occupied.has(id),
                    `inputBindings.${slot.id}: 身份重复占用`,
                );
                occupied.add(id);
                expected = spec.defaults.subject;
            } else {
                add(
                    !slot.image &&
                        target?.kind === "content_element" &&
                        binding.distributionPolicy === "replace_as_unit",
                    `inputBindings.${slot.id}: 内容只支持文本与内容目标`,
                );
                if (binding.valueKind === "exact_text") {
                    add(
                        element?.category === "text",
                        `inputBindings.${slot.id}: 文本目标类型不匹配`,
                    );
                    expected = spec.defaults.texts[id];
                } else if (binding.valueKind === "color") {
                    add(
                        colors.has(id),
                        `inputBindings.${slot.id}: 配色目标类型不匹配`,
                    );
                    expected = spec.defaults.colors[id];
                } else if (binding.valueKind === "scene_description") {
                    add(
                        element?.category === "subject" ||
                            element?.category === "accent" ||
                            element?.category === "decoration",
                        `inputBindings.${slot.id}: 内容目标类型不匹配`,
                    );
                    expected =
                        element?.category === "subject"
                            ? spec.defaults.subject
                            : spec.defaults.specifiedContent[id];
                } else add(false, `inputBindings.${slot.id}: 缺少 valueKind`);
            }
            add(
                expected !== undefined && slot.text.defaultValue === expected,
                `inputSchema.${slot.id}: 默认值与 designSpec.defaults 不一致`,
            );
        }
    }
    for (const element of spec.elements)
        if (element.category === "text") {
            add(
                Boolean(spec.defaults.texts[element.id]),
                `designSpec.defaults.texts.${element.id}: 缺少默认文字`,
            );
        }
    return issues;
}
export function candidateIssues(candidate: PrintDesignCandidate): string[] {
    const issues = draftIssues(candidate.draft);
    const spec = candidate.draft.runtimeSemantics.designSpec;
    for (const element of spec.elements)
        if (
            element.category === "text" &&
            !candidate.observation.texts.some(
                (text) => text.elementId === element.id,
            )
        )
            issues.push(`observation.texts.${element.id}: 缺少原文观察`);
    for (const text of candidate.observation.texts)
        if (
            !spec.elements.some(
                (element) =>
                    element.id === text.elementId &&
                    element.category === "text",
            ) ||
            spec.defaults.texts[text.elementId] !== text.text
        )
            issues.push("observation.texts: 原文与文字元素不一致");
    return issues;
}

export function displayPrompt(spec: DesignSpec): string {
    return [
        `画一张 T 恤印花图案，${spec.whole.tone}。`,
        `主体：${spec.defaults.subject}。`,
        ...spec.elements
            .filter((element) => element.category === "text")
            .map(
                (element) =>
                    `${element.role}：${spec.defaults.texts[element.id]}。`,
            ),
        ...spec.whole.colorRoles.map(
            (role) => `${role.name}：${spec.defaults.colors[role.id]}。`,
        ),
    ].join("\n");
}
export function compileResult(
    candidate: PrintDesignCandidate,
    imageUrl: string,
    image: TemplateImage,
) {
    const issues = candidateIssues(candidate);
    if (issues.length) throw new PrintDesignContractError(issues);
    const template = {
        ...candidate.draft,
        status: "DRAFT" as const,
        kind: "PROMPT" as const,
        imageN: 1 as const,
        preprocessSteps: [],
        imageSize: templateImageSize(image),
        cover: imageUrl,
        referenceImage: imageUrl,
        promptTemplate: displayPrompt(
            candidate.draft.runtimeSemantics.designSpec,
        ),
    };
    if (!validateOutput(template))
        throw new PrintDesignContractError(["最终作者 JSON 未通过固定 Schema"]);
    return { template };
}
export const printDesignOutputSchema = z.strictObject({
    template: z
        .unknown()
        .refine((value) => {
            if (
                !value ||
                typeof value !== "object" ||
                !("runtimeSemantics" in value) ||
                !("promptTemplate" in value) ||
                !validateOutput(value)
            )
                return false;
            const result = draftSchema.safeParse(
                Object.fromEntries(
                    fields.map((field) => [field, Reflect.get(value, field)]),
                ),
            );
            return (
                result.success &&
                value.promptTemplate ===
                    displayPrompt(result.data.runtimeSemantics.designSpec) &&
                draftIssues(result.data).length === 0
            );
        })
        .meta({
            ...source,
            required: [
                ...new Set([
                    ...source.required,
                    ...fields,
                    "status",
                    "kind",
                    "imageN",
                    "preprocessSteps",
                    "cover",
                    "referenceImage",
                    "imageSize",
                ]),
            ],
        }),
});
