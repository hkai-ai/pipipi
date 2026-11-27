/** 从 Memebuy 同步生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
import { z } from "zod";

import { normalizeDesignSpec } from "./design-spec-axes.js";

// v4 拆解数据（designSpec）。字段名英文 camelCase，括号内为方法正本 print-design-preparation.md
// “数据格式”一节里的中文名。生成时由确定性编译器读取（第 3 阶段）；第 1 阶段只入库与展示。

const designIdSchema = z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,79}$/u, "id 需为 snake_case");
const shortText = z.string().trim().min(1).max(1000);
const optionalText = z.string().trim().max(1000).optional();

// 档位：同手法 / 标志特征 / 同款
export const designSpecTierSchema = z.enum([
    "same_method",
    "signature",
    "same_design",
]);

// 版面 JSON 的一个框（元素角色、bbox、z）
const layoutElementSchema = z
    .object({
        id: z.string().trim().min(1).max(80),
        role: shortText,
        // content / text 可用 "@元素id" 引用用户内容，由编译器在编译时替换
        content: optionalText,
        text: optionalText,
        shape: optionalText,
        region: optionalText,
        bbox: z
            .tuple([z.number(), z.number(), z.number(), z.number()])
            .optional(),
        z: z.number().int().min(0).max(99),
    })
    .strict();

// 配色角色：用途、面积与作用对象；具体颜色只出现在 defaults.colors
const colorRoleSchema = z
    .object({
        // 稳定标识，color 绑定的 targetIds 引用它
        id: designIdSchema,
        // 角色名（角色）：提示词里的 {色:角色名} 占位按它引用
        name: z.string().trim().min(1).max(40),
        // 用途（用途）
        usage: shortText,
        // 作用于（作用于）：被它着色的元素 id
        appliesTo: z.array(designIdSchema).max(40).optional(),
        // 属于画法（属于画法）：画在主体身上但属于画法的颜色，不算给主体上色
        belongsToTechnique: z.boolean().optional(),
    })
    .strict();

const compositionSchema = z
    .object({
        // 画幅（画幅）
        canvas: optionalText,
        // 平衡（平衡）
        balance: shortText,
        // 构图类型（类型）
        types: z.array(shortText).min(1).max(10),
        // 版面（版面）
        layout: z.array(layoutElementSchema).min(1).max(40),
        // 关系（关系）：[甲, 关系词, 乙]
        relations: z
            .array(z.tuple([shortText, shortText, shortText]))
            .max(40)
            .optional(),
        // 层次（层次）
        layers: optionalText,
        // 视觉轻重（视觉轻重）
        visualWeight: optionalText,
        // 疏密（疏密）
        density: shortText,
    })
    .strict();

// 背景角色：无背景 / 衬底（纯色、纸色等不表示地点的底）/ 承重（背景是一个地点或环境）
export const designSpecBackgroundSchema = z.enum([
    "none",
    "backdrop",
    "load_bearing",
]);

// 边框库：容器选「边框库」时只能从这几种里选，措辞由编译器固定生成（只有一层）
export const DESIGN_SPEC_BORDER_IDS = [
    "rounded_line",
    "polaroid",
    "torn_paper",
    "stamp",
    "arch",
] as const;
export const designSpecBorderIdSchema = z.enum(DESIGN_SPEC_BORDER_IDS);
export type DesignSpecBorderId = z.infer<typeof designSpecBorderIdSchema>;

// 主体边界：完整 / 被切开（写明哪条边、切口怎么收）
export const designSpecBoundarySchema = z.discriminatedUnion("state", [
    z.object({ state: z.literal("complete") }).strict(),
    z
        .object({ state: z.literal("cut"), edge: shortText, finish: shortText })
        .strict(),
]);

// 容器：无 / 自带框（封面自带的框，边由「收形」元素描述）/ 边框库
export const designSpecContainerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("own") }).strict(),
    z
        .object({
            kind: z.literal("library"),
            borderId: designSpecBorderIdSchema,
            // 边框颜色取自画面的配色角色 id
            colorRole: designIdSchema.optional(),
        })
        .strict(),
]);

// 边缘质感：硬边 / 毛发软边 / 渐隐光晕
export const designSpecEdgeQualitySchema = z.enum(["hard", "soft_fur", "fade"]);

const LEGACY_PRINT_FORMS = ["standalone", "rect_patch", "bleed_crop"] as const;

const wholeShape = {
    // 调性（调性）
    tone: shortText,
    // 画法（画法）
    technique: shortText,
    composition: compositionSchema,
    // 表达机制（表达机制）：推断，须人确认
    mechanism: shortText,
    // 配色总述（配色总述）
    paletteSummary: optionalText,
    // 配色角色（配色角色）
    colorRoles: z.array(colorRoleSchema).max(20),
    // 不附模板原图：封面带整幅背景或光晕、又要做独立图形时由作者标注（缺省 = 按档位，同款档附原图）
    omitTemplateImage: z.boolean().optional(),
    // 印前（印前）：软边处理与纸色
    prePress: z
        .object({
            softEdge: optionalText,
            paperColor: z.string().trim().max(100).nullable().optional(),
            paperColorHex: z
                .string()
                .trim()
                .regex(/^#[0-9a-fA-F]{6}$/u, "纸色色值须为 #RRGGBB")
                .nullable()
                .optional(),
        })
        .strict()
        .optional(),
};

// 印花处理的正交轴。新旧两种形状都接受（含并存），只校验、不改写：解析结果保持输入原样，
// 读侧一律经 normalizeDesignSpec 取轴（新字段优先，缺的轴由旧 printForm / crop 推出）。
const wholeInputSchema = z
    .object({
        ...wholeShape,
        background: designSpecBackgroundSchema.optional(),
        boundary: designSpecBoundarySchema.optional(),
        container: designSpecContainerSchema.optional(),
        edge: designSpecEdgeQualitySchema.optional(),
        // 旧：印花形态（独立图形 / 矩形贴片 / 出血裁切）与裁切，只作读取兼容；新写入不再使用
        printForm: z.enum(LEGACY_PRINT_FORMS).optional(),
        crop: z
            .object({ edge: shortText, finish: shortText })
            .strict()
            .optional(),
    })
    .strict()
    .superRefine((whole, ctx) => {
        if (whole.background === undefined && whole.printForm === undefined) {
            ctx.addIssue({
                code: "custom",
                path: ["background"],
                message: "whole 缺少 background（旧数据为 printForm）",
            });
        }
    });

const wholeSchema = wholeInputSchema;

const elementBase = {
    id: designIdSchema,
    // 作用（作用）：它在图里起什么作用
    purpose: shortText,
    // 实例（实例）：原图里它具体长什么样，只作证据
    instance: optionalText,
};

const subjectOccurrencesSchema = z
    .object({
        // 同一主体在画面中总共出现的次数（至少 2 次；单次出现省略 occurrences）
        count: z.number().int().min(2).max(20),
        // equal=多处等重散布（如多头像拼贴）；primary_plus_satellites=1 个主像 + 外围小像
        arrangement: z.enum(["equal", "primary_plus_satellites"]),
        // 主次尺度与排布说明（如“8 个较小悬浮头像按上中下交错散布”或“中央大头像 + 四角小头像”）
        scaleNote: optionalText,
        // 各处局部变体（如“部分戴小花或眼镜，左下小头像戴黑色像素墨镜”）
        variants: z.array(shortText).max(10).optional(),
    })
    .strict();

const subjectElementSchema = z
    .object({
        ...elementBase,
        category: z.literal("subject"),
        // 原物（原物）：原图主体是什么，供检查与附图说明
        originalObject: optionalText,
        // 外形特征（外形特征）：只写原物独有的外形
        shapeFeatures: z.array(shortText).max(20).optional(),
        // 通用外形（通用外形）
        genericShape: optionalText,
        // 固有色策略（固有色策略）：保留 / 随配色
        inherentColorPolicy: z.enum(["keep", "follow_palette"]),
        // 姿态（姿态）：同款档锁定
        pose: optionalText,
        // 同一主体重复出现多次（1 对 N 拼贴）；单实例省略
        occurrences: subjectOccurrencesSchema.optional(),
    })
    .strict();

const decorativeElementShape = {
    ...elementBase,
    // 描述（描述）：可用 {内容} 标出用户内容的插入位置，{色:角色名} 引用颜色
    description: shortText,
    // 位置（位置）、层级（层级）
    position: optionalText,
    layer: optionalText,
    // 带字道具（带字道具）：道具上自带的字画成灰色笔划纹理，不进文字白名单
    hasPropText: z.boolean().optional(),
    // 戴在主体身上（帽子、头巾、头盔、触角等）：主体被替换时编译器追加让位句，标志特征从配饰下面或两侧伸出
    wornOnSubject: z.boolean().optional(),
};

const accentElementSchema = z
    .object({ ...decorativeElementShape, category: z.literal("accent") })
    .strict();
const decorationElementSchema = z
    .object({ ...decorativeElementShape, category: z.literal("decoration") })
    .strict();

const textElementSchema = z
    .object({
        ...elementBase,
        // 文字元素以角色与字形描述，作用可省略
        purpose: optionalText,
        category: z.literal("text"),
        // 角色（角色）：词头、音标、释义等
        role: shortText,
        // 字形（字形）
        letterform: shortText,
        // 跟随主体（跟随主体）：这处文字是“关于主体的”（词头、释义等）。主体被换掉而用户没填这一处时，
        // 不写默认字，改由模型按新主体来写
        followsSubject: z.literal(true).optional(),
    })
    .strict();

// 收形（收形）：图案边缘怎样收成一个形状
const edgeElementSchema = z
    .object({
        ...elementBase,
        category: z.literal("edge"),
        description: shortText,
    })
    .strict();

export const designSpecElementSchema = z.discriminatedUnion("category", [
    subjectElementSchema,
    accentElementSchema,
    decorationElementSchema,
    textElementSchema,
    edgeElementSchema,
]);

// 作者默认迁移条目：用户什么都不填时的主体、文字、指定内容与配色（迁移）。
const defaultsSchema = z
    .object({
        // 主体（主体）：身份与外形的完整短语
        subject: shortText,
        // 主体名（主体名）
        subjectName: shortText,
        // 主体外形（主体外形）
        subjectShape: optionalText,
        // 主体固有色（主体固有色）
        subjectInherentColor: optionalText,
        // 姿态（姿态）、趣味（趣味）
        pose: optionalText,
        fun: optionalText,
        // 文字（文字）：文字元素 id → 逐字文本
        texts: z.record(designIdSchema, z.string().min(1).max(2000)),
        // 指定内容（指定内容）：装饰、点缀元素 id → 用户指定内容
        specifiedContent: z.record(designIdSchema, z.string().min(1).max(1000)),
        // 点缀来源（点缀来源）：场景伴生点缀元素 id → 来源
        accentSources: z.record(designIdSchema, z.string().min(1).max(1000)),
        // 配色（配色）：配色角色 id → 具体颜色
        colors: z.record(designIdSchema, z.string().min(1).max(200)),
    })
    .strict();

/** 结构化修改：扩展自迁移条目的可选修改，加画法、边框、场景与人数（用于建议与 P4 翻译层）。 */
export const designSpecStructuredEditSchema = z
    .object({
        // 文字替换主体时必须同时给出 subject 和 subjectName；需传照片时由照片提供主体，不预设这两个字段
        subject: shortText.optional(),
        subjectName: shortText.optional(),
        subjectShape: shortText.optional(),
        subjectInherentColor: shortText.optional(),
        pose: shortText.optional(),
        fun: shortText.optional(),
        texts: z.record(designIdSchema, z.string().min(1).max(2000)).optional(),
        specifiedContent: z
            .record(designIdSchema, z.string().min(1).max(1000))
            .optional(),
        accentSources: z
            .record(designIdSchema, z.string().min(1).max(1000))
            .optional(),
        colors: z.record(designIdSchema, z.string().min(1).max(200)).optional(),
        techniqueOverride: shortText.optional(),
        borderOverride: designSpecBorderIdSchema.optional(),
        sceneOverride: shortText.optional(),
        headcount: z.number().int().min(1).max(20).optional(),
    })
    .strict();

/** 模板拆解生成的用户建议（推荐 3～5 条）：一句给用户看的问句 + 一份结构化修改。 */
export const designSpecSuggestionSchema = z
    .object({
        id: designIdSchema,
        label: shortText,
        requiresPhoto: z.boolean().optional(),
        edit: designSpecStructuredEditSchema,
    })
    .strict();

export type DesignSpecStructuredEdit = z.infer<
    typeof designSpecStructuredEditSchema
>;
export type DesignSpecSuggestion = z.infer<typeof designSpecSuggestionSchema>;

function hasStructuredEditEntries(edit: DesignSpecStructuredEdit): boolean {
    return (
        edit.subject !== undefined ||
        edit.subjectName !== undefined ||
        edit.subjectShape !== undefined ||
        edit.subjectInherentColor !== undefined ||
        edit.pose !== undefined ||
        edit.fun !== undefined ||
        edit.techniqueOverride !== undefined ||
        edit.borderOverride !== undefined ||
        edit.sceneOverride !== undefined ||
        edit.headcount !== undefined ||
        Object.keys(edit.texts ?? {}).length > 0 ||
        Object.keys(edit.specifiedContent ?? {}).length > 0 ||
        Object.keys(edit.accentSources ?? {}).length > 0 ||
        Object.keys(edit.colors ?? {}).length > 0
    );
}

export const designSpecSchema = z
    .object({
        // 档位（档位）
        tier: designSpecTierSchema,
        whole: wholeSchema,
        // 元素层（元素）
        elements: z.array(designSpecElementSchema).min(1).max(40),
        // 标志特征（标志特征）、锁定实例（锁定实例）、禁用词（禁用词）
        signatureFeatures: z.array(shortText).max(20),
        lockedInstances: z.array(shortText).max(40),
        bannedWords: z.array(z.string().trim().min(1).max(100)).max(60),
        // 印花适配：直接可印 / 需印前处理 / 不适合服装
        printFit: z
            .object({
                // 适配结论改为由轴推导（resolveDesignSpecVerdict）；作者可显式给出，不适合服装一律保留
                verdict: z
                    .enum(["direct", "needs_prep", "not_for_apparel"])
                    .optional(),
                // 光感是否属于意境（属于意境的不实心化）
                lightIsMood: z.boolean(),
                // 适用衣服色（缺省 any）：浅色元素在浅色衣服上、深色元素在深色衣服上会消失
                garmentTone: z.enum(["light", "dark", "any"]).optional(),
                // 主体可换性（缺省 swappable）：可换 / 受参考图牵制 / 主体即设计（整张图的造型就是主体）
                subjectSwap: z
                    .enum(["swappable", "constrained", "is_design"])
                    .optional(),
                // 推荐印法
                recommendedMethod: optionalText,
            })
            .strict(),
        defaults: defaultsSchema,
        // 拆解附带建议（可选，不填不影响既有运行语义哈希）
        suggestions: z
            .array(designSpecSuggestionSchema)
            .min(1)
            .max(5)
            .optional(),
    })
    .strict()
    .superRefine((spec, ctx) => {
        const elementIds = new Map<string, number>();
        for (const [index, element] of spec.elements.entries()) {
            if (elementIds.has(element.id)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["elements", index, "id"],
                    message: `元素 id「${element.id}」重复`,
                });
            }
            elementIds.set(element.id, index);
        }
        const { background, boundary, container, subjectSwap } =
            normalizeDesignSpec(spec);
        if (background === "load_bearing") {
            if (container.kind === "none") {
                if (
                    spec.elements.some((element) => element.category === "edge")
                ) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["elements"],
                        message:
                            "无容器的满版承重画面不能包含收形边框元素；若原图自带外框请将 container 设为 own",
                    });
                }
            } else if (boundary.state === "cut") {
                ctx.addIssue({
                    code: "custom",
                    path: ["whole", "boundary"],
                    message: "承重背景是一块完整的贴片，主体边界不能被切开",
                });
            }
        }
        if (container.kind === "library") {
            if (spec.elements.some((element) => element.category === "edge")) {
                ctx.addIssue({
                    code: "custom",
                    path: ["elements"],
                    message:
                        "容器选边框库时外轮廓由边框库生成，不能再写收形元素（会叠出第二层边）",
                });
            }
            if (
                container.colorRole &&
                !spec.whole.colorRoles.some((r) => r.id === container.colorRole)
            ) {
                ctx.addIssue({
                    code: "custom",
                    path: ["whole", "container", "colorRole"],
                    message: `边框颜色角色「${container.colorRole}」不在配色角色里`,
                });
            }
        }
        const subjects = spec.elements.filter(
            (element) => element.category === "subject",
        );
        if (subjects.length !== 1) {
            ctx.addIssue({
                code: "custom",
                path: ["elements"],
                message: "designSpec 必须且只能有一个主体元素",
            });
        }
        const roleIds = new Set<string>();
        for (const [index, role] of spec.whole.colorRoles.entries()) {
            if (roleIds.has(role.id) || elementIds.has(role.id)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["whole", "colorRoles", index, "id"],
                    message: `配色角色 id「${role.id}」与其他元素或配色角色重复`,
                });
            }
            roleIds.add(role.id);
            for (const target of role.appliesTo ?? []) {
                if (!elementIds.has(target)) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["whole", "colorRoles", index, "appliesTo"],
                        message: `配色角色「${role.id}」作用于不存在的元素「${target}」`,
                    });
                }
            }
        }
        const categoryById = new Map(
            spec.elements.map((element) => [element.id, element.category]),
        );
        for (const id of Object.keys(spec.defaults.texts)) {
            if (categoryById.get(id) !== "text") {
                ctx.addIssue({
                    code: "custom",
                    path: ["defaults", "texts", id],
                    message: `defaults.texts 的键「${id}」不是文字元素`,
                });
            }
        }
        for (const id of Object.keys(spec.defaults.specifiedContent)) {
            const category = categoryById.get(id);
            if (category !== "accent" && category !== "decoration") {
                ctx.addIssue({
                    code: "custom",
                    path: ["defaults", "specifiedContent", id],
                    message: `defaults.specifiedContent 的键「${id}」不是点缀或装饰元素`,
                });
            }
        }
        for (const id of Object.keys(spec.defaults.accentSources)) {
            if (categoryById.get(id) !== "accent") {
                ctx.addIssue({
                    code: "custom",
                    path: ["defaults", "accentSources", id],
                    message: `defaults.accentSources 的键「${id}」不是点缀元素`,
                });
            }
        }
        for (const id of Object.keys(spec.defaults.colors)) {
            if (!roleIds.has(id)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["defaults", "colors", id],
                    message: `defaults.colors 的键「${id}」不是配色角色`,
                });
            }
        }
        for (const id of roleIds) {
            if (!(id in spec.defaults.colors)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["defaults", "colors"],
                    message: `配色角色「${id}」缺少默认颜色`,
                });
            }
        }
        const suggestionIds = new Set<string>();
        for (const [index, suggestion] of (spec.suggestions ?? []).entries()) {
            if (suggestionIds.has(suggestion.id)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["suggestions", index, "id"],
                    message: `建议 id「${suggestion.id}」重复`,
                });
            }
            suggestionIds.add(suggestion.id);
            const { edit } = suggestion;
            if (!suggestion.requiresPhoto && !hasStructuredEditEntries(edit)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["suggestions", index, "edit"],
                    message: "不需要照片的建议至少要包含一项结构化修改",
                });
            }
            const hasSubject = edit.subject !== undefined;
            const hasSubjectName = edit.subjectName !== undefined;
            if (hasSubject !== hasSubjectName) {
                ctx.addIssue({
                    code: "custom",
                    path: ["suggestions", index, "edit"],
                    message: "替换主体必须同时提供 subject 和 subjectName",
                });
            }
            if (suggestion.requiresPhoto && (hasSubject || hasSubjectName)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["suggestions", index, "edit"],
                    message:
                        "requiresPhoto 为 true 时由用户上传照片提供主体，不能预设 subject 或 subjectName",
                });
            }
            if (
                subjectSwap === "is_design" &&
                (suggestion.requiresPhoto ||
                    hasSubject ||
                    hasSubjectName ||
                    edit.subjectShape !== undefined ||
                    edit.subjectInherentColor !== undefined)
            ) {
                ctx.addIssue({
                    code: "custom",
                    path: ["suggestions", index],
                    message:
                        "主体可换性为「主体即设计（is_design）」时不能生成换主体或需传图类建议",
                });
            }
            for (const id of Object.keys(edit.texts ?? {})) {
                if (categoryById.get(id) !== "text") {
                    ctx.addIssue({
                        code: "custom",
                        path: ["suggestions", index, "edit", "texts", id],
                        message: `建议修改的文字键「${id}」不是文字元素`,
                    });
                }
            }
            for (const id of Object.keys(edit.specifiedContent ?? {})) {
                const category = categoryById.get(id);
                if (category !== "accent" && category !== "decoration") {
                    ctx.addIssue({
                        code: "custom",
                        path: [
                            "suggestions",
                            index,
                            "edit",
                            "specifiedContent",
                            id,
                        ],
                        message: `建议修改的指定内容键「${id}」不是点缀或装饰元素`,
                    });
                }
            }
            for (const id of Object.keys(edit.accentSources ?? {})) {
                if (categoryById.get(id) !== "accent") {
                    ctx.addIssue({
                        code: "custom",
                        path: [
                            "suggestions",
                            index,
                            "edit",
                            "accentSources",
                            id,
                        ],
                        message: `建议修改的点缀来源键「${id}」不是点缀元素`,
                    });
                }
            }
            for (const id of Object.keys(edit.colors ?? {})) {
                if (!roleIds.has(id)) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["suggestions", index, "edit", "colors", id],
                        message: `建议修改的配色键「${id}」不是配色角色`,
                    });
                }
            }
            if (
                edit.borderOverride &&
                container.kind !== "library" &&
                background !== "load_bearing"
            ) {
                ctx.addIssue({
                    code: "custom",
                    path: ["suggestions", index, "edit", "borderOverride"],
                    message:
                        "只有容器为边框库或背景为承重时才能设置 borderOverride",
                });
            }
            if (
                edit.sceneOverride !== undefined &&
                background !== "load_bearing"
            ) {
                ctx.addIssue({
                    code: "custom",
                    path: ["suggestions", index, "edit", "sceneOverride"],
                    message:
                        "只有背景角色为承重（load_bearing）时才能设置 sceneOverride",
                });
            }
        }
    });

export type DesignSpec = z.infer<typeof designSpecSchema>;
export type DesignSpecElement = z.infer<typeof designSpecElementSchema>;
