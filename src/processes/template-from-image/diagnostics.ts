/** 将模板校验问题收敛为有界字段路径和固定错误类型，排除模型内容与动态键。 */
export type TemplateValidationDiagnostic = Readonly<{
    path: string;
    code: string;
}>;

export type TemplateDiagnostic = Readonly<{
    event: "template_diagnostic";
    runId: string;
    stage: "compilation" | "correction" | "review" | "validation";
    attempt: number;
    category: "json_syntax" | "structure" | "contract" | "execution";
    issues: readonly TemplateValidationDiagnostic[];
}>;

// 只保留固定合同字段；槽位、标签、组件等模型生成的键统一隐藏。
const fields = new Set(
    `analysis draft review checks changes path value valueJson
    templateValue fixedMechanism backendFactRefs field index
    componentGraph id visualFields spatialRelations componentIds relationIndex
    editableCandidates gates userMotivation independentUserChoice meaningfulVariation
    visuallyVisible modelControllable mechanismPreserved
    slotEvidence slotCoverageReview tagEvidence targetScopes substitutions
    featureAuthority owner basis evidence runtimeFactRef
    visualEvidence searchIntent category
    subjectIdentity species bodyForm pose expression clothing accessories color material
    key title description promptTemplate inputSchema version slots type text image
    presentation allowCustom defaultValue placeholder suggestions label required
    runtimeSemantics visualContract medium styleTraits composition relations colorAndLight
    inputBindings operation targetIds targets role region
    metadata tags prompt needsReview rationale reason passed observation
    reviewedPlanSha256 reviewedDraftSha256 issues`.split(/\s+/),
);
const codes = new Set(
    `invalid_type invalid_value invalid_format too_small too_big invalid_union
    unrecognized_keys invalid_key invalid_element not_multiple_of custom
    type required additionalProperties enum const minItems maxItems minLength maxLength
    pattern format oneOf anyOf allOf minimum maximum contract`.split(/\s+/),
);

export function validationDiagnostics(
    issues: readonly Readonly<{ path: readonly PropertyKey[]; code: string }>[],
): readonly TemplateValidationDiagnostic[] {
    return issues.slice(0, 16).map((issue) => ({
        path: `/${issue.path
            .slice(0, 20)
            .map((part) =>
                typeof part === "number" &&
                Number.isInteger(part) &&
                part >= 0 &&
                part <= 10_000
                    ? part
                    : typeof part === "string" && fields.has(part)
                      ? part
                      : "*",
            )
            .join("/")}`,
        code: codes.has(issue.code) ? issue.code : "contract",
    }));
}
