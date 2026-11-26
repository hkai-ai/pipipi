/** 从 Memebuy 同步生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
// 跟随主体的文字（compile.py 的 follow_texts）：独立成文件，避免编译与版面渲染互相引用。
import type { DesignSpec } from "./design-spec-schema.js";

import type { MigrationEntry } from "./types.js";

type TextElement = Extract<
    DesignSpec["elements"][number],
    { category: "text" }
>;

/** 跟随主体的文字：主体被换掉、用户又没填这一处时，不写默认字，改由模型按新主体来写。 */
export function followTexts(
    spec: DesignSpec,
    entry: MigrationEntry,
): TextElement[] {
    if (!entry.subjectReplaced) return [];
    return spec.elements.filter(
        (element): element is TextElement =>
            element.category === "text" &&
            element.followsSubject === true &&
            !(element.id in entry.texts),
    );
}
