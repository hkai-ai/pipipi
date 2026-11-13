/** 将固定来源拆解检查器的失败定位到被检查的描述字段，仅在请求内匹配原文。 */

import type { DesignSpec } from "./vendor/design-spec-schema.js";
import { sliceCodePoints } from "./vendor/py-compat.js";

type Field = { path: (string | number)[]; value: string };
function descriptionFields(spec: DesignSpec) {
    const fields: Field[] = [];
    const add = (path: Field["path"], value: string | undefined) => {
        if (value) fields.push({ path, value });
    };
    const { whole, defaults } = spec;
    for (const key of ["tone", "technique", "paletteSummary"] as const)
        add(["whole", key], whole[key]);
    for (const key of ["density", "layers", "visualWeight", "balance"] as const)
        add(["whole", "composition", key], whole.composition[key]);
    whole.composition.types.forEach((value, i) =>
        add(["whole", "composition", "types", i], value),
    );
    whole.composition.layout.forEach((item, i) => {
        for (const key of ["role", "shape", "region"] as const)
            add(["whole", "composition", "layout", i, key], item[key]);
    });
    whole.composition.relations?.forEach((relation, i) =>
        add(["whole", "composition", "relations", i], relation.join(" ")),
    );
    whole.colorRoles.forEach((role, i) =>
        add(["whole", "colorRoles", i, "usage"], role.usage),
    );
    spec.elements.forEach((el, i) => {
        const path = ["elements", i];
        if (el.category === "subject") {
            add([...path, "genericShape"], el.genericShape);
            add([...path, "pose"], el.pose);
        } else if (el.category === "text")
            add([...path, "letterform"], el.letterform);
        else {
            add([...path, "description"], el.description);
            if (el.category !== "edge") {
                add([...path, "position"], el.position);
                add([...path, "layer"], el.layer);
            }
        }
    });
    for (const key of [
        "subject",
        "subjectName",
        "subjectShape",
        "fun",
        "pose",
        "subjectInherentColor",
    ] as const)
        add(["defaults", key], defaults[key]);
    for (const key of ["accentSources", "specifiedContent"] as const)
        for (const [id, value] of Object.entries(defaults[key]))
            add(["defaults", key, id], value);
    return fields;
}
export function designFindings(spec: DesignSpec, messages: string[]) {
    const fields = descriptionFields(spec);
    return messages.flatMap((message) => {
        if (message.startsWith("印花形态为矩形贴片"))
            return [{ message, path: ["elements"], code: "missing_edge" }];
        if (message.startsWith("主体固有色策略")) {
            const i = spec.whole.colorRoles.findIndex(
                (r) =>
                    message ===
                    `主体固有色策略为“保留”，配色角色「${r.name}」的用途却写了主体：${r.usage}`,
            );
            return [
                {
                    message,
                    path:
                        i < 0
                            ? ["whole", "colorRoles"]
                            : ["whole", "colorRoles", i, "usage"],
                    code: "inherent_color_conflict",
                },
            ];
        }
        const rules = [
            ["原物词", "source_word"],
            ["抽象风格词", "abstract_style"],
            ["会画成半透明的词", "transparency_word"],
            ["颜色占位", "unknown_color_role"],
        ] as const;
        const code =
            rules.find(([start]) => message.startsWith(start))?.[1] ??
            "draft_semantics";
        const matches = fields.filter(({ path, value }) => {
            if (
                code !== "unknown_color_role" &&
                path[1] === "composition" &&
                (path[2] === "types" || path[2] === "balance")
            )
                return false;
            const excerpt = sliceCodePoints(value, 50);
            const suffix =
                code === "transparency_word"
                    ? "（改写成能画实的形状或颗粒）"
                    : "";
            return message.endsWith(`：${excerpt}${suffix}`);
        });
        return matches.length
            ? matches.map(({ path }) => ({ message, path, code }))
            : [{ message, path: [], code }];
    });
}
