/** 从固定 Memebuy 来源生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
// 拆解数据检查：移植自 compile.py 的“检查”段。错误导入时拒绝，警告交给人复核；报错文案与 Python 一致。
import type { DesignSpec, DesignSpecElement } from "./design-spec-schema.js";

import { sliceCodePoints, sortedUnique } from "./py-compat.js";
import type {
    AttachmentFacts,
    DesignSpecCheckResult,
    MigrationEntry,
} from "./types.js";
import {
    CROWD_WORDS,
    colorPlaceholderPattern,
    GLOW_WORDS,
    PRINT_FORM_LABEL,
    STYLE_WORDS,
} from "./vocabulary.js";

type SubjectElement = Extract<DesignSpecElement, { category: "subject" }>;

export function findSubjectElement(spec: DesignSpec): SubjectElement {
    const subject = spec.elements.find(
        (element): element is SubjectElement => element.category === "subject",
    );
    if (!subject) throw new Error("designSpec 缺少主体元素");
    return subject;
}

/** 会进提示词、且属于描述性的字段（参与风格词与原物词检查）。 */
export function collectDescriptiveTexts(
    spec: DesignSpec,
    entries: readonly MigrationEntry[],
): string[] {
    const { whole } = spec;
    const composition = whole.composition;
    const texts: string[] = [
        whole.tone,
        whole.technique,
        composition.density,
        composition.layers ?? "",
        composition.visualWeight ?? "",
        whole.paletteSummary ?? "",
        ...whole.colorRoles.map((role) => role.usage),
    ];
    for (const item of composition.layout)
        texts.push(item.role, item.shape ?? "", item.region ?? "");
    for (const relation of composition.relations ?? [])
        texts.push(relation.join(" "));
    for (const element of spec.elements) {
        if (element.category === "subject") {
            texts.push(element.genericShape ?? "", element.pose ?? "");
        } else if (
            element.category === "accent" ||
            element.category === "decoration"
        ) {
            texts.push(
                element.description,
                element.position ?? "",
                element.layer ?? "",
            );
        } else if (element.category === "text") {
            texts.push(element.letterform);
        } else {
            texts.push(element.description);
        }
    }
    for (const entry of entries) {
        texts.push(
            entry.subject,
            entry.subjectName,
            entry.subjectShape ?? "",
            entry.fun ?? "",
            entry.pose ?? "",
            entry.subjectInherentColor ?? "",
            ...Object.values(entry.accentSources),
            ...Object.values(entry.specifiedContent),
        );
    }
    return texts;
}

function collectUserTexts(entries: readonly MigrationEntry[]): Set<string> {
    const values = new Set<string>();
    for (const entry of entries) {
        for (const value of Object.values(entry.specifiedContent))
            values.add(value);
        for (const value of Object.values(entry.texts)) values.add(value);
        values.add(entry.subject);
    }
    return values;
}

/** 检查拆解数据与迁移条目；传入 attachments 时附带“档位与附图不一致”的警告。 */
export function checkDesignSpec(
    spec: DesignSpec,
    entries: readonly MigrationEntry[],
    attachments?: AttachmentFacts,
): DesignSpecCheckResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const subject = findSubjectElement(spec);
    const descriptive = collectDescriptiveTexts(spec, entries);
    const userTexts = collectUserTexts(entries);
    const roleNames = new Set(spec.whole.colorRoles.map((role) => role.name));
    const banned = [
        ...spec.bannedWords,
        subject.originalObject ?? "",
        ...(subject.shapeFeatures ?? []),
    ].filter((word) => word);

    for (const value of userTexts) {
        for (const word of GLOW_WORDS) {
            if (value.includes(word)) {
                warnings.push(
                    `用户内容「${value}」含「${word}」，照写进提示词，可能画出半透明`,
                );
            }
        }
    }
    for (const text of descriptive) {
        for (const word of banned) {
            if (text.includes(word))
                errors.push(
                    `原物词「${word}」出现在：${sliceCodePoints(text, 50)}`,
                );
        }
        for (const word of STYLE_WORDS) {
            if (text.includes(word)) {
                errors.push(
                    `抽象风格词「${word}」出现在：${sliceCodePoints(text, 50)}`,
                );
            }
        }
        for (const word of GLOW_WORDS) {
            if (text.includes(word) && !userTexts.has(text)) {
                errors.push(
                    `会画成半透明的词「${word}」出现在：${sliceCodePoints(text, 50)}（改写成能画实的形状或颗粒）`,
                );
            }
        }
    }
    const placeholderTexts = [
        ...descriptive,
        spec.whole.composition.balance,
        ...spec.whole.composition.types,
    ];
    for (const text of placeholderTexts) {
        for (const match of text.matchAll(colorPlaceholderPattern())) {
            const role = match[1] as string;
            if (!roleNames.has(role)) {
                errors.push(
                    `颜色占位 {色:${role}} 不在配色角色里：${sliceCodePoints(text, 50)}`,
                );
            }
        }
    }
    if (subject.inherentColorPolicy === "keep") {
        for (const role of spec.whole.colorRoles) {
            if (role.belongsToTechnique) continue; // 画在主体身上、但属于画法的颜色（腮红、高光），不算给主体上色
            const hit = role.appliesTo
                ? role.appliesTo.includes(subject.id)
                : role.usage.includes("主体");
            if (hit) {
                errors.push(
                    `主体固有色策略为“保留”，配色角色「${role.name}」的用途却写了主体：${role.usage}`,
                );
            }
        }
    }
    if (
        spec.whole.printForm === "rect_patch" &&
        !spec.elements.some((element) => element.category === "edge")
    ) {
        errors.push(
            "印花形态为矩形贴片时必须有收形元素：贴片的边框要设计出来（包边、撕边、齿边、圆角、票根、相框等），不能是画布直接裁出的矩形",
        );
    }
    if (attachments) {
        if (spec.tier === "same_design" && !attachments.templateImage) {
            warnings.push("档位为同款，通常应附模板原图（--ref orig）");
        }
        if (spec.tier === "same_method" && attachments.templateImage) {
            warnings.push("档位为同手法，附原图会让构图和配色跟着原图走");
        }
    }
    if (
        spec.whole.printForm !== "rect_patch" &&
        spec.whole.printForm !== "bleed_crop"
    ) {
        for (const text of descriptive) {
            for (const word of CROWD_WORDS) {
                if (text.includes(word)) {
                    warnings.push(
                        `「${word}」容易让图案碰到画布边（印花形态为${PRINT_FORM_LABEL[spec.whole.printForm]}）：${sliceCodePoints(text, 40)}`,
                    );
                }
            }
        }
    }
    return { errors: sortedUnique(errors), warnings: sortedUnique(warnings) };
}
