/** 从 Memebuy 同步生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
// 印花处理轴的读侧视图：存储里新旧两种形状并存，下游（编译器、背景、适配结论、后台展示）只通过这里读轴。
// 纯函数、不改写输入，已冻结的运行语义因此逐字节不变。
import type { DesignSpec, DesignSpecBorderId } from "./design-spec-schema.js";

export type DesignSpecBackgroundRole = "none" | "backdrop" | "load_bearing";
export type DesignSpecBoundary =
    | { state: "complete" }
    | { state: "cut"; edge: string; finish: string };
export type DesignSpecContainer =
    | { kind: "none" }
    | { kind: "own" }
    | { kind: "library"; borderId: DesignSpecBorderId; colorRole?: string };

/** 轴视图：每个轴都有确定取值。 */
export interface DesignSpecAxes {
    background: DesignSpecBackgroundRole;
    boundary: DesignSpecBoundary;
    container: DesignSpecContainer;
    edge: "hard" | "soft_fur" | "fade";
    garmentTone: "light" | "dark" | "any";
    subjectSwap: "swappable" | "constrained" | "is_design";
}

const LEGACY_CROP_DEFAULT = { edge: "下缘", finish: "用笔触自然收住" } as const;

/**
 * 逐轴取值：新字段优先；缺的轴由旧 printForm / crop 推出——
 * standalone → 无背景、完整、无容器；rect_patch → 承重、完整、自带框；bleed_crop → 无背景、被切开（取 crop）。
 * 边缘缺省硬边，适用衣服色缺省通用，主体可换性缺省可换。
 */
export function normalizeDesignSpec(
    spec: Pick<DesignSpec, "whole" | "printFit">,
): DesignSpecAxes {
    const { whole, printFit } = spec;
    const form = whole.printForm;
    return {
        background:
            whole.background ??
            (form === "rect_patch" ? "load_bearing" : "none"),
        boundary:
            whole.boundary ??
            (form === "bleed_crop"
                ? {
                      state: "cut",
                      edge: whole.crop?.edge ?? LEGACY_CROP_DEFAULT.edge,
                      finish: whole.crop?.finish ?? LEGACY_CROP_DEFAULT.finish,
                  }
                : { state: "complete" }),
        container:
            whole.container ??
            (form === "rect_patch" ? { kind: "own" } : { kind: "none" }),
        edge: whole.edge ?? "hard",
        garmentTone: printFit.garmentTone ?? "any",
        subjectSwap: printFit.subjectSwap ?? "swappable",
    };
}
