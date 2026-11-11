/** 定义活动失败的固定诊断词表与中文提示，并过滤正文和动态字段。 */
const diagnosticAdvice = {
    internal_failure: [
        "执行发生异常，具体原因尚未确认",
        "请携带运行 ID 和失败步骤检查服务端执行记录。",
    ],
    process_timeout: [
        "流程超过执行时限",
        "请检查失败步骤耗时与整体预算，并先核对下游请求状态。",
    ],
    process_cancelled: [
        "流程已取消",
        "请核对取消来源和下游请求状态，不要直接重新执行。",
    ],
    dependency_failure: [
        "业务依赖执行失败",
        "请检查对应依赖及原请求状态；不要直接重放付费操作。",
    ],
    authentication: ["模型服务拒绝鉴权", "请检查服务端凭证和访问权限。"],
    rate_limit: ["模型服务限流", "请检查服务端额度与并发限制。"],
    connection: ["模型连接失败", "请检查模型网关的连通性。"],
    timeout: ["模型请求超时", "请检查模型响应耗时与执行时限。"],
    cancelled: ["模型执行已取消", "请核对取消来源；不要当作依赖故障重试。"],
    model_refusal: ["模型拒绝生成方案", "请核对模型拒绝与用户要求。"],
    provider_rejected: ["模型服务拒绝请求", "请检查服务端模型配置与请求协议。"],
    provider_unavailable: [
        "模型服务暂时不可用",
        "请检查模型网关与上游服务状态。",
    ],
    configuration: ["模型会话初始化失败", "请检查服务端模型与固定规则配置。"],
    empty_response: ["模型返回空内容", "请检查模型是否返回最终文本。"],
    incomplete_response: ["模型响应未完成", "请检查模型输出限制与服务状态。"],
    context_limit: [
        "模型输入超出上下文限制",
        "请检查输入大小和服务端模型配置。",
    ],
    invalid_contract: [
        "模型结果不符合业务要求",
        "请检查结果与业务约束、获准工具调用是否一致。",
    ],
    invalid_json: [
        "模型结果不是合法 JSON",
        "请检查模型结构化输出能力与编译规则。",
    ],
    invalid_schema: [
        "模型结果未通过规则校验",
        "请按净化字段路径核对编译合同。",
    ],
    execution: [
        "模型执行失败，具体原因尚未确认",
        "请携带运行 ID 核对模型服务记录。",
    ],
} as const;

const diagnosticStages = {
    execution: "执行业务流程",
    dependency: "调用业务依赖",
    session: "创建模型会话",
    request: "调用模型",
    response: "读取模型响应",
    json: "解析模型 JSON",
    schema: "校验编译规则",
} as const;

export type ActivityDiagnostic = Readonly<{
    stage: keyof typeof diagnosticStages;
    code: keyof typeof diagnosticAdvice;
    issues?: readonly Readonly<{ path: string; code: string }>[];
}>;

const issueCodes = new Set([
    "invalid_type",
    "invalid_value",
    "too_small",
    "too_big",
    "unrecognized_keys",
    "custom",
    "invalid_format",
    "invalid_union",
    "invalid_key",
    "invalid_element",
    "not_multiple_of",
]);

// 固定模型输出合同的字段词表；动态键、原值和校验消息不进入诊断。
const fields = new Set(
    `prompt recipe interpretation layout anchor typography accent texture mood
    wallpaperPlacement crop subjectCoverage windowCount windowConstellation sizeHierarchy
    dominantApplication extractionCount extractionGeometry cartoonTreatment caricatureMutation
    midtoneMap polarity signalEmphasis newsIdentity coreTension realityAnchor factExclusions
    sceneKernel promptModel content summary result`.split(/\s+/),
);

export function diagnosticPath(path: readonly PropertyKey[]): string {
    return `/${path
        .slice(0, 8)
        .map((part) =>
            typeof part === "number" &&
            Number.isInteger(part) &&
            part >= 0 &&
            part <= 10000
                ? part
                : typeof part === "string" && fields.has(part)
                  ? part
                  : "*",
        )
        .join("/")}`;
}

/** 记录和展示前按同一固定词表再次净化，兼容未携带诊断的旧活动。 */
export function sanitizeActivityDiagnostic(
    value: unknown,
): ActivityDiagnostic | undefined {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as ActivityDiagnostic;
    if (
        typeof candidate.stage !== "string" ||
        typeof candidate.code !== "string" ||
        !Object.hasOwn(diagnosticStages, candidate.stage) ||
        !Object.hasOwn(diagnosticAdvice, candidate.code)
    )
        return undefined;
    return {
        stage: candidate.stage,
        code: candidate.code,
        ...(Array.isArray(candidate.issues)
            ? {
                  issues: candidate.issues.slice(0, 8).map((issue) => ({
                      path:
                          typeof issue?.path === "string" &&
                          issue.path.startsWith("/")
                              ? issue.path === "/"
                                  ? "/"
                                  : diagnosticPath(
                                        issue.path
                                            .slice(1)
                                            .split("/")
                                            .map((part: string) =>
                                                /^(0|[1-9]\d{0,3}|10000)$/u.test(
                                                    part,
                                                )
                                                    ? Number(part)
                                                    : part,
                                            ),
                                    )
                              : "/*",
                      code: issueCodes.has(issue?.code) ? issue.code : "custom",
                  })),
              }
            : {}),
    };
}

export function explainDiagnostic(diagnostic: ActivityDiagnostic): {
    stage: string;
    reason: string;
    title: string;
    next: string;
} {
    const [title, next] = diagnosticAdvice[diagnostic.code];
    return {
        stage: diagnosticStages[diagnostic.stage],
        reason: title,
        title: `${diagnosticStages[diagnostic.stage]}：${title}`,
        next,
    };
}

/** 明确的业务依赖错误与同一活动中的内部异常分开记录。 */
export function dependencyDiagnostic(
    knownDependencyFailure: boolean,
): ActivityDiagnostic {
    return knownDependencyFailure
        ? { stage: "dependency", code: "dependency_failure" }
        : { stage: "execution", code: "internal_failure" };
}
