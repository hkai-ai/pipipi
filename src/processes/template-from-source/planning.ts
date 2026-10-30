/** 将逐区原图排版观察投影到既有策略合同，不让替换文案重写观察事实。 */
import { z } from "zod";
import { replacementStrategySchema } from "./strategy.js";

const observation = z.string().trim().min(1).max(240);
const layoutSchema = z.strictObject({
    readingDirection: observation.describe(
        "原图的阅读方向与行数；这不代表文字行的几何形状。",
    ),
    lineContour: observation.describe(
        "逐行比较起始、中部、末端的相对位置，记录整行外轮廓的具体走向与变化；直线、弯曲或不规则均按图描述，不用横排代替形状。",
    ),
    baseline: observation.describe(
        "逐行观察字形落点的连线与倾斜变化，区分整体走向和个别字高差异；无法看清时明确说明。",
    ),
    glyphShape: observation.describe(
        "原图字形的宽高、粗细、倾斜及非机械规整特征。",
    ),
    spacing: observation.describe("原图字距、行距及其可见变化。"),
    alignment: observation.describe(
        "原图各行相互对齐方式和相对大小，不以新文案重新设计。",
    ),
});
const {
    regionId,
    originalText,
    language,
    layout: _layout,
    location,
    jokeRole,
    ...textDecisions
} = replacementStrategySchema.shape.textActions.element.shape;
const {
    textActions: _textActions,
    mechanismAnalysis,
    visualFeatures,
    ...decisions
} = replacementStrategySchema.shape;

// 模型先完成逐区观察，再做替换决定；持久化 Schema 和审批摘要顺序不变。
export const planningSchema = z.strictObject({
    textActions: z
        .array(
            z.strictObject({
                regionId,
                originalText,
                language,
                location,
                layout: layoutSchema.describe(
                    "原图文字排版的逐项观察；没有文字时 textActions 为空，不补造文字区。",
                ),
                jokeRole,
                ...textDecisions,
            }),
        )
        .max(100),
    mechanismAnalysis,
    visualFeatures,
    ...decisions,
});

const labels: Record<keyof z.infer<typeof layoutSchema>, string> = {
    readingDirection: "阅读与行数",
    lineContour: "整行轮廓",
    baseline: "基线",
    glyphShape: "字形",
    spacing: "间距",
    alignment: "对齐与比例",
};

export function projectPlanning(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return value;
    if (!("textActions" in value) || !Array.isArray(value.textActions))
        return value;
    return {
        ...value,
        textActions: value.textActions.map((action: unknown) => {
            if (!action || typeof action !== "object" || !("layout" in action))
                return action;
            const parsed = layoutSchema.safeParse(action.layout);
            // 无法读取的观察交给既有字段修正；不伪造缺失事实或吞掉其他结构问题。
            if (!parsed.success) return action;
            return {
                ...action,
                layout: (Object.keys(labels) as (keyof typeof labels)[])
                    .map((key) => `${labels[key]}：${parsed.data[key]}`)
                    .join("；"),
            };
        }),
    };
}
