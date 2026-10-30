/** 将模型异常归类为固定诊断码与用户提示，不传出原始消息、地址或凭据。 */
export function templateExecutionFailure(error: unknown) {
    const messages: string[] = [];
    let current = error;
    for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
        messages.push(current.message);
        current = current.cause;
    }
    const text = messages.join("\n");
    const rules = [
        [
            "authentication",
            /invalid.api.key|unauthorized|authentication|\b401\b/iu,
            "模型服务鉴权失败",
        ],
        [
            "rate_limit",
            /rate.limit|too many requests|\b429\b/iu,
            "模型服务限流",
        ],
        ["timeout", /timed?\s*out|timeout|ETIMEDOUT/iu, "模型请求超时"],
        [
            "connection",
            /connection error|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|premature close/iu,
            "模型连接中断",
        ],
        [
            "context_limit",
            /context.length|context.window|maximum.*tokens|too many tokens/iu,
            "模型上下文超限",
        ],
        ["empty_response", /Agent response was empty/iu, "模型返回空内容"],
        [
            "configuration",
            /configured.*model.*unavailable|不支持图片输入/iu,
            "模型配置不支持本次任务",
        ],
        [
            "model_response",
            /Agent did not produce a successful response/iu,
            "模型未返回完整结果",
        ],
    ] as const;
    for (const [code, pattern, message] of rules)
        if (pattern.test(text)) return { code, message };
    return { code: "execution", message: "执行发生异常" };
}
