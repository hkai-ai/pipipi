/** 从 Memebuy 同步生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
// 版面 JSON 的文本形态：逐字复刻 compile.py 的 layout()，缩进与分隔符都是提示词的一部分。
import type { DesignSpec } from "./design-spec-schema.js";

import { followTexts } from "./follow-texts.js";
import { pythonJsonDumps } from "./py-compat.js";
import type { MigrationEntry } from "./types.js";

type LayoutItem = DesignSpec["whole"]["composition"]["layout"][number];

/** 解析版面元素的 `@key` 引用；无法解析时返回 undefined。 */
export function resolveLayoutReference(
    key: string,
    spec: DesignSpec,
    entry: MigrationEntry,
): string | undefined {
    const subject = spec.elements.find(
        (element) => element.category === "subject",
    );
    if (key === "主体" || key === subject?.id) return entry.subjectName;
    const pending = followTexts(spec, entry).find(
        (element) => element.id === key,
    );
    if (pending) return `（按新主体写的${pending.role}）`;
    const entryValue =
        entry.texts[key] ??
        entry.specifiedContent[key] ??
        entry.accentSources[key];
    if (entryValue !== undefined) return entryValue;
    const element = spec.elements.find((item) => item.id === key);
    if (element) {
        if (element.instance) return element.instance;
        if (element.category !== "subject" && element.category !== "text")
            return element.description;
    }
    return undefined;
}

function lookupContent(
    key: string,
    spec: DesignSpec,
    entry: MigrationEntry,
): string {
    const value = resolveLayoutReference(key, spec, entry);
    if (value === undefined)
        throw new Error(`版面引用的 @${key} 在迁移条目里没有值`);
    return value;
}

// 键序固定：Python 保留拆解数据里的书写顺序，这里取示例通用的顺序，zod 解析后原顺序已不可得
function layoutRecord(
    item: LayoutItem,
    spec: DesignSpec,
    entry: MigrationEntry,
) {
    const resolve = (value: string | undefined) =>
        value?.startsWith("@")
            ? lookupContent(value.slice(1), spec, entry)
            : value;
    const record: Record<string, string | number | number[]> = {
        id: item.id,
        role: item.role,
    };
    const text = resolve(item.text);
    const content = resolve(item.content);
    if (text !== undefined) record.text = text;
    if (content !== undefined) record.content = content;
    if (item.shape !== undefined) record.shape = item.shape;
    if (item.region !== undefined) record.region = item.region;
    if (item.bbox !== undefined) record.bbox = [...item.bbox];
    record.z = item.z;
    return record;
}

export function renderLayoutJson(
    spec: DesignSpec,
    entry: MigrationEntry,
): string {
    const composition = spec.whole.composition;
    const items = composition.layout.map((item) =>
        layoutRecord(item, spec, entry),
    );
    const head: Array<[string, string | string[] | undefined]> = [
        ["canvas", composition.canvas],
        ["balance", composition.balance],
        ["type", composition.types],
    ];
    const lines = ["{"];
    for (const [key, value] of head) {
        if (
            value === undefined ||
            value === "" ||
            (Array.isArray(value) && value.length === 0)
        )
            continue;
        lines.push(` "${key}": ${pythonJsonDumps(value)},`);
    }
    lines.push(' "elements": [');
    items.forEach((item, index) => {
        lines.push(
            `  ${pythonJsonDumps(item)}${index < items.length - 1 ? "," : ""}`,
        );
    });
    const relations = composition.relations ?? [];
    lines.push(" ],", ' "relations": [');
    relations.forEach((relation, index) => {
        lines.push(
            `  ${pythonJsonDumps(relation)}${index < relations.length - 1 ? "," : ""}`,
        );
    });
    lines.push(" ]", "}");
    return lines.join("\n");
}
