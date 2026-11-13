/** 从固定 Memebuy 来源生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
import { z } from "zod";

// v4 拆解数据（designSpec）。字段名英文 camelCase，括号内为方法正本 print-design-preparation.md
// “数据格式”一节里的中文名。生成时由确定性编译器读取（第 3 阶段）；第 1 阶段只入库与展示。

const designIdSchema = z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,79}$/u, "id 需为 snake_case");
const shortText = z.string().trim().min(1).max(1000);
const optionalText = z.string().trim().max(1000).optional();

/// 档位：同手法 / 标志特征 / 同款
export const designSpecTierSchema = z.enum([
    "same_method",
    "signature",
    "same_design",
]);

/// 版面 JSON 的一个框（元素角色、bbox、z）
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

/// 配色角色：用途、面积与作用对象；具体颜色只出现在 defaults.colors
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

const wholeSchema = z
    .object({
        // 调性（调性）
        tone: shortText,
        // 画法（画法）
        technique: shortText,
        composition: compositionSchema,
        // 印花形态（印花形态）：独立图形 / 矩形贴片 / 出血裁切
        printForm: z.enum(["standalone", "rect_patch", "bleed_crop"]),
        // 裁切（裁切）：出血裁切时从哪条边切、切口怎么收
        crop: z
            .object({ edge: shortText, finish: shortText })
            .strict()
            .optional(),
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
            })
            .strict()
            .optional(),
    })
    .strict();

const elementBase = {
    id: designIdSchema,
    // 作用（作用）：它在图里起什么作用
    purpose: shortText,
    // 实例（实例）：原图里它具体长什么样，只作证据
    instance: optionalText,
};

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

/// 作者默认迁移条目：用户什么都不填时的主体、文字、指定内容与配色（迁移）。
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
                verdict: z.enum(["direct", "needs_prep", "not_for_apparel"]),
                // 光感是否属于意境（属于意境的不实心化）
                lightIsMood: z.boolean(),
                // 推荐印法
                recommendedMethod: optionalText,
            })
            .strict(),
        defaults: defaultsSchema,
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
    });

export type DesignSpec = z.infer<typeof designSpecSchema>;
export type DesignSpecElement = z.infer<typeof designSpecElementSchema>;
