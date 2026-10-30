/** 表情包 Agent 的结构化输出的业务校验失败类型。 */
export type AiTextOutputFailure = {
    reason: "invalid_json" | "invalid_schema";
    issues?: Array<{ path: string; code: string }>;
};
