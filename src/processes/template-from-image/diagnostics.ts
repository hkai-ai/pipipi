/** 将模板校验问题收敛为有界字段路径和固定错误类型，排除模型内容与动态键。 */
import type { TemplateValidationDiagnostic } from "../../process-runtime/template-diagnostics.js";

export {
    type TemplateValidationDiagnostic,
    validationDiagnostics,
} from "../../process-runtime/template-diagnostics.js";

export type TemplateDiagnostic = Readonly<{
    event: "template_diagnostic";
    runId: string;
    stage: "compilation" | "correction" | "review" | "validation";
    attempt: number;
    category: "json_syntax" | "structure" | "contract" | "execution";
    issues: readonly TemplateValidationDiagnostic[];
}>;
