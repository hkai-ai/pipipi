/** 从 Memebuy 同步生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
// v4 拆解数据决定的“生成输出形态”：参考图与背景。纯函数，供对齐、任务提交与透明模式判定共用。
import { normalizeDesignSpec } from "./design-spec-axes.js";
import type { DesignSpec } from "./design-spec-schema.js";
import { designSpecSchema } from "./design-spec-schema.js";

/** 只有同款档附模板原图；作者标了 omitTemplateImage 的同款模板也不附。 */
export function shouldAttachDesignSpecTemplateImage(
    spec: Pick<DesignSpec, "tier" | "whole">,
): boolean {
    return spec.tier === "same_design" && spec.whole.omitTemplateImage !== true;
}

export type DesignSpecBackground = "transparent" | "opaque";

/**
 * 出图背景由背景角色与容器共同决定：
 * - 承重 + 无容器（none）= 满版不透明原画（适配毛毯/手机壳/海报，服饰在下游程序收边）；
 * - 承重 + 带容器（own / library）= 透明画布 + 不透明设计贴片；
 * - 无背景与衬底 = 透明，但光感属于意境的用不透明深色底生成。
 * printFit 评估可印性，不改变背景。
 */
export function resolveDesignSpecBackground(
    spec: Pick<DesignSpec, "whole" | "printFit">,
): DesignSpecBackground {
    const axes = normalizeDesignSpec(spec);
    if (axes.background === "load_bearing") {
        return axes.container.kind === "none" ? "opaque" : "transparent";
    }
    return spec.printFit.lightIsMood ? "opaque" : "transparent";
}

export type DesignSpecPrintForm = "standalone" | "rect_patch" | "bleed_crop";

/** 由轴反推旧三态，供后台展示与诊断沿用：切开 → 出血裁切；承重 → 矩形贴片；其余 → 独立图形。 */
export function printFormOf(
    spec: Pick<DesignSpec, "whole" | "printFit">,
): DesignSpecPrintForm {
    const axes = normalizeDesignSpec(spec);
    if (axes.background === "load_bearing") return "rect_patch";
    if (axes.boundary.state === "cut") return "bleed_crop";
    return "standalone";
}

/** 后台展示用的形态名：在旧三态之外，区分“满版原画”（承重无容器）与“自带框”（去底后自带框）。 */
export function printFormDisplayLabel(
    spec: Pick<DesignSpec, "whole" | "printFit">,
): string {
    const axes = normalizeDesignSpec(spec);
    if (axes.background === "load_bearing" && axes.container.kind === "none")
        return "满版原画";
    const form = printFormOf(spec);
    if (form === "standalone" && axes.container.kind === "own") return "自带框";
    return {
        standalone: "独立图形",
        rect_patch: "矩形贴片",
        bleed_crop: "出血裁切",
    }[form];
}

export type DesignSpecVerdict = NonNullable<DesignSpec["printFit"]["verdict"]>;

/**
 * 适配结论（直接可印 / 需印前处理 / 不适合服装）由轴推导，只用于统计与筛选：
 * - 作者显式给了 not_for_apparel：保留（海报类，轴无法表达）；
 * - 适用衣服色不是通用，或边缘不是硬边（毛发软边、渐隐）：需印前处理；
 * - 作者显式给了 needs_prep：保留（印前问题可能来自水印等轴之外的原因）；
 * - 其余：直接可印。
 */
export function resolveDesignSpecVerdict(
    spec: Pick<DesignSpec, "whole" | "printFit">,
): DesignSpecVerdict {
    const { verdict } = spec.printFit;
    const axes = normalizeDesignSpec(spec);
    if (verdict === "not_for_apparel") return "not_for_apparel";
    if (axes.garmentTone !== "any" || axes.edge !== "hard") return "needs_prep";
    return verdict === "needs_prep" ? "needs_prep" : "direct";
}

/** 未解析的运行语义是否为 v4（拆解数据）；只读判别字段，不校验结构。 */
export function isDesignSpecRuntimeSemantics(raw: unknown): boolean {
    return (
        typeof raw === "object" &&
        raw !== null &&
        (raw as { version?: unknown }).version === 4
    );
}

/** 从未解析的运行语义里取出合法的 designSpec；非 v4 或结构不合法返回 null，供只读派生（打标、搜索）使用。 */
export function parseDesignSpec(raw: unknown): DesignSpec | null {
    if (!isDesignSpecRuntimeSemantics(raw)) return null;
    const parsed = designSpecSchema.safeParse(
        (raw as { designSpec?: unknown }).designSpec,
    );
    return parsed.success ? parsed.data : null;
}
