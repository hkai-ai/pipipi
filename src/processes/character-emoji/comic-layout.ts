/** 保留 v1 本地回放的固定布局投影，v2 不调用此模块。 */
import type { ComicPlan } from "./schema.js";

export function fixedComicLayout<
    T extends {
        page: ComicPlan["page"];
        panels: Array<{ index: number; frame: string }>;
    },
>(plan: T): T {
    const count = plan.panels.length;
    const wide = ["3:2", "2:1"].includes(plan.page.aspectRatio);
    const columns = count <= 3 ? (wide ? count : 1) : 2;
    const rows = Math.ceil(count / columns);
    return {
        ...plan,
        page: {
            ...plan.page,
            layout: `${rows}行，常规行${columns}列；各行等高、同行等宽，末行不足时均分整行；格间留白一致，无嵌格或重叠。`,
            readingOrder: `逐行从左到右、从上到下：${plan.panels.map((panel) => panel.index).join("→")}`,
        },
        panels: plan.panels.map((panel, index) => {
            const row = Math.floor(index / columns);
            const cells = Math.min(columns, count - row * columns);
            return {
                ...panel,
                frame: `第${row + 1}行第${(index % columns) + 1}格；占内容区宽度1/${cells}、高度1/${rows}，独立画格。`,
            };
        }),
    };
}
