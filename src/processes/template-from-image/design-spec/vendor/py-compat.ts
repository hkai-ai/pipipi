/** 从固定 Memebuy 来源生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
// 与 Python 行为对齐的小工具：compile.py 按码点切片、按码点排序，json.dumps 带空格分隔。

/** 按码点取前 n 个字符（Python 的 s[:n]）；JS 的 slice 按 UTF-16 单元，会劈开代理对。 */
export function sliceCodePoints(text: string, count: number): string {
    return Array.from(text).slice(0, count).join("");
}

function compareCodePoints(left: string, right: string): number {
    const a = Array.from(left);
    const b = Array.from(right);
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
        const diff =
            ((a[i] as string).codePointAt(0) ?? 0) -
            ((b[i] as string).codePointAt(0) ?? 0);
        if (diff !== 0) return diff;
    }
    return a.length - b.length;
}

/** Python 的 sorted(set(items))。 */
export function sortedUnique(items: Iterable<string>): string[] {
    return [...new Set(items)].sort(compareCodePoints);
}

type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

/**
 * 等价于 Python json.dumps(ensure_ascii=False)：分隔符为 ", " 与 ": "。
 * 数字按 JS 规则输出：JSON 不区分 1 与 1.0，作者写 1.0 时 Python 输出“1.0”，这里输出“1”。
 */
export function pythonJsonDumps(value: JsonValue): string {
    if (Array.isArray(value))
        return `[${value.map(pythonJsonDumps).join(", ")}]`;
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value).map(
            ([key, item]) => `${JSON.stringify(key)}: ${pythonJsonDumps(item)}`,
        );
        return `{${entries.join(", ")}}`;
    }
    return JSON.stringify(value);
}

/** 把所有出现的 needle 换成 replacement，replacement 里的 $ 不当特殊字符。 */
export function replaceAllLiteral(
    text: string,
    needle: string,
    replacement: string,
): string {
    return text.split(needle).join(replacement);
}
