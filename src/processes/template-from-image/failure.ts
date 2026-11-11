/** 复用统一模型错误分类，为模板各阶段提供固定中文说明。 */
import { agentDiagnostic } from "../../agent-runtime/diagnostics.js";
import { explainDiagnostic } from "../../process-runtime/diagnostics.js";

export function templateExecutionFailure(error: unknown) {
    const diagnostic = agentDiagnostic(error);
    return {
        code: diagnostic.code,
        message: `${explainDiagnostic(diagnostic).reason}。`,
    };
}
