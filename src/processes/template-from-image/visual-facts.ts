/** 统一解析全局与目标视觉事实引用，保留准确路径并拒绝失效目标。 */
import { z } from "zod";
import type { TemplateDraft } from "./types.js";

export const globalFields = [
    "styleTraits",
    "composition",
    "relations",
    "colorAndLight",
] as const;
export const targetFactRef = z.strictObject({
    targetId: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
    field: z.enum(["appearance", "pose"]),
    index: z.int().min(0).max(39),
});
export const arrayFactRef = z.union([
    z.strictObject({
        field: z.enum(globalFields),
        index: z.int().min(0).max(63),
    }),
    targetFactRef,
]);
export const selectionFactRef = z.union([
    z.strictObject({
        field: z.enum(["medium", ...globalFields]),
        index: z.int().min(0).max(63).nullable(),
    }),
    targetFactRef,
]);
type Runtime = TemplateDraft["runtimeSemantics"];
export type FactRef = z.infer<typeof selectionFactRef>;

export function resolveVisualFact(
    ref: FactRef,
    visual: Runtime["visualContract"],
    targets: Runtime["targetInstances"] = [],
) {
    const root = "/analysis/semanticModel/runtimeSemantics";
    if ("targetId" in ref) {
        const index = targets.findIndex((target) => target.id === ref.targetId);
        return {
            path: `${root}/targetInstances/${index}/${ref.field}/${ref.index}`,
            fact: targets[index]?.[ref.field]?.[ref.index] ?? null,
        };
    }
    return {
        path: `${root}/visualContract/${ref.field}${ref.index === null ? "" : `/${ref.index}`}`,
        fact:
            ref.field === "medium"
                ? ref.index === null
                    ? visual.medium
                    : null
                : ref.index === null
                  ? null
                  : (visual[ref.field][ref.index] ?? null),
    };
}

export function targetFacts(runtime: Runtime): string[] {
    return runtime.version === 3
        ? runtime.targetInstances.flatMap((target) => [
              ...(target.appearance ?? []),
              ...(target.pose ?? []),
          ])
        : [];
}
