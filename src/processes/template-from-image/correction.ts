/** 对结构完整的候选应用有界字段替换，未涉及内容逐值保留。 */
import { z } from "zod";
import { TemplateContractError } from "./contract.js";

export const templateCorrectionSchema = z.strictObject({
    changes: z
        .array(
            z.strictObject({
                path: z
                    .string()
                    .regex(/^\/(analysis|draft)\/.+/)
                    .max(500),
                value: z.json(),
            }),
        )
        .min(1)
        .max(64),
});

/** 优先列出父容器，路径较多时仍可通过替换父容器完成修正。 */
export function templateCorrectionPaths(plan: object): string[] {
    const paths: string[] = [];
    const pending = [{ value: plan, path: "" }];
    for (const item of pending) {
        if (!item.value || typeof item.value !== "object") continue;
        for (const [key, value] of Object.entries(item.value)) {
            if (!key || ["__proto__", "constructor", "prototype"].includes(key))
                continue;
            const path = `${item.path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
            if (path.length > 500) continue;
            if (item.path && /^\/(analysis|draft)\//.test(path))
                paths.push(path);
            if (paths.length === 250) return paths;
            pending.push({ value, path });
        }
    }
    return paths;
}

export function applyTemplateCorrection(
    previous: object,
    value: unknown,
): unknown {
    const parsed = templateCorrectionSchema.safeParse(value);
    if (!parsed.success || JSON.stringify(value).length > 100_000)
        throw new TemplateContractError([
            "修正必须返回有界的 changes 字段补丁",
        ]);
    const result = structuredClone(previous);
    const paths: string[] = [];
    for (const change of parsed.data.changes) {
        if (
            /~(?![01])/u.test(change.path) ||
            paths.some(
                (path) =>
                    path === change.path ||
                    path.startsWith(`${change.path}/`) ||
                    change.path.startsWith(`${path}/`),
            )
        )
            throw new TemplateContractError([
                "修正路径不能无效、重复或互相覆盖",
            ]);
        paths.push(change.path);
        const keys = change.path
            .slice(1)
            .split("/")
            .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
        if (
            keys.some(
                (key) =>
                    !key ||
                    ["__proto__", "constructor", "prototype"].includes(key),
            )
        )
            throw new TemplateContractError(["修正包含不可用的字段路径"]);
        let parent: unknown = result;
        for (const key of keys.slice(0, -1)) parent = ownValue(parent, key);
        const key = keys.at(-1) as string;
        ownValue(parent, key);
        (parent as Record<string, unknown>)[key] = change.value;
    }
    return result;
}

function ownValue(value: unknown, key: string): unknown {
    if (
        !value ||
        typeof value !== "object" ||
        !Object.hasOwn(value, key) ||
        (Array.isArray(value) && !/^(0|[1-9]\d*)$/u.test(key))
    )
        throw new TemplateContractError([
            "修正路径必须指向现有字段；新增或删除内容需替换其父对象或数组",
        ]);
    return (value as Record<string, unknown>)[key];
}
