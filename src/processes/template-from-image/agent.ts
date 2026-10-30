/** 定义模板生成与独立视觉复核的受控输入，复核一次返回修正结果。 */
import type { TemplateImage } from "./image.js";

export type TemplateAgentRequest = Readonly<{
    image: TemplateImage;
    note?: string;
    correction?: Readonly<{ previous: unknown; issues: readonly string[] }>;
    signal: AbortSignal;
}>;
export type TemplateAgent = Readonly<{
    compile: (request: TemplateAgentRequest) => Promise<unknown>;
    review: (
        request: Readonly<{
            image: TemplateImage;
            note?: string;
            plan: unknown;
            issues: readonly string[];
            signal: AbortSignal;
        }>,
    ) => Promise<unknown>;
}>;
