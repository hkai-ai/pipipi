/** 限制方案修正只能替换校验涉及的字段，并在合并后重跑完整合同。 */
import { z } from "zod";
import {
    parseReplacementStrategy,
    type StrategyIssue,
    strategyFields,
} from "./strategy.js";

export function strategyCorrectionSchema(issues: readonly StrategyIssue[]) {
    const fields = [...new Set(issues.flatMap((issue) => issue.fields))];
    if (!fields.length) throw new Error("没有可修正字段");
    return z.strictObject({
        changes: z
            .array(
                z.strictObject({
                    field: z.enum(fields),
                    valueJson: z.string().min(1).max(200_000),
                }),
            )
            .min(1)
            .max(strategyFields.length),
    });
}

export function applyStrategyCorrection(
    candidate: unknown,
    issues: readonly StrategyIssue[],
    correction: unknown,
) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
        throw new Error("方案必须是对象");
    if (JSON.stringify(correction).length > 250_000)
        throw new Error("方案补丁超出预算");
    const { changes } = strategyCorrectionSchema(issues).parse(correction);
    if (new Set(changes.map((change) => change.field)).size !== changes.length)
        throw new Error("方案补丁字段重复");
    const updated = structuredClone(candidate) as Record<string, unknown>;
    for (const { field, valueJson } of changes)
        updated[field] = JSON.parse(valueJson);
    return parseReplacementStrategy(updated);
}
