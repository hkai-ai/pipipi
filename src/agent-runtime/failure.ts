/** 按模型边界和可识别的错误信号生成固定分类，不输出供应商异常正文。 */
import type { ActivityDiagnostic } from "../process-runtime/diagnostics.js";

/** 原文只供同次有界修正使用，不能直接序列化到日志或响应。 */
export class AgentJsonSyntaxError extends SyntaxError {
    constructor(readonly responseText: string) {
        super("模型响应不是合法 JSON");
        this.name = "AgentJsonSyntaxError";
    }
}

export class AgentExecutionFailure extends Error {
    constructor(
        readonly diagnostic: ActivityDiagnostic,
        cause?: unknown,
    ) {
        super("Agent execution failed", { cause });
        this.name = "AgentExecutionFailure";
    }
}

export function agentExecutionDiagnostic(
    error: unknown,
    stage: ActivityDiagnostic["stage"],
): ActivityDiagnostic {
    if (error instanceof AgentExecutionFailure) return error.diagnostic;
    // 字符串协议由 Pi Adapter 解释；通用分类器只读取结构化状态。
    let current = error;
    for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
        const status =
            "status" in current
                ? current.status
                : "statusCode" in current
                  ? current.statusCode
                  : undefined;
        const code = "code" in current ? current.code : undefined;
        const message = current.message;
        const httpStatus = typeof status === "number" ? status : Number.NaN;
        if (code === "context_length_exceeded")
            return { stage, code: "context_limit" };
        if (
            code === "invalid_api_key" ||
            httpStatus === 401 ||
            httpStatus === 403
        )
            return { stage, code: "authentication" };
        if (code === "rate_limit_exceeded" || httpStatus === 429)
            return { stage, code: "rate_limit" };
        if (httpStatus >= 500 && httpStatus <= 599)
            return { stage, code: "provider_unavailable" };
        if (httpStatus >= 400 && httpStatus <= 499)
            return { stage, code: "provider_rejected" };
        if (current.name === "AbortError") return { stage, code: "cancelled" };
        if (
            current.name === "TimeoutError" ||
            code === "ETIMEDOUT" ||
            code === "UND_ERR_CONNECT_TIMEOUT" ||
            /^(?:Request timed out\.?|ETIMEDOUT)$/iu.test(message)
        )
            return { stage, code: "timeout" };
        if (
            ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(
                String(code),
            ) ||
            /^(?:Connection error|fetch failed|socket hang up)\b/iu.test(
                message,
            )
        )
            return { stage, code: "connection" };
        if (/^(?:No API key found for )/u.test(message))
            return { stage, code: "configuration" };
        current = current.cause;
    }
    return { stage, code: "execution" };
}
