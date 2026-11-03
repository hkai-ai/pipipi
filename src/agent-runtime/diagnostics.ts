/** 统一模型调用、JSON、字段和业务合同错误的脱敏诊断与公开说明。 */
import { z } from "zod";
import {
    type ActivityDiagnostic,
    diagnosticPath,
    explainDiagnostic,
    sanitizeActivityDiagnostic,
} from "../process-runtime/diagnostics.js";
import {
    AgentExecutionFailure,
    AgentJsonSyntaxError,
    agentExecutionDiagnostic,
} from "./failure.js";

export function agentDiagnostic(error: unknown): ActivityDiagnostic {
    if (error instanceof AgentJsonSyntaxError)
        return { stage: "json", code: "invalid_json" };
    if (error instanceof z.ZodError) {
        return (
            sanitizeActivityDiagnostic({
                stage: "schema",
                code: "invalid_schema",
                issues: error.issues.slice(0, 8).map((issue) => ({
                    path: diagnosticPath(issue.path),
                    code: issue.code,
                })),
            }) ?? { stage: "schema", code: "invalid_schema" }
        );
    }
    return agentExecutionDiagnostic(error, "request");
}

export function agentFailureMessage(activity: string, error: unknown): string {
    const detail = explainDiagnostic(agentDiagnostic(error));
    return `${activity}失败（${detail.title}）。`;
}

/** 业务规则不通过时显式标记，不从异常文案推断字段或规则。 */
export class AgentContractFailure extends AgentExecutionFailure {
    constructor() {
        super({ stage: "schema", code: "invalid_contract" });
    }
}
