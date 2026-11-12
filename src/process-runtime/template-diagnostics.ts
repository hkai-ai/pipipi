/** 定义模板活动归档与运维日志共用的净化字段、规则和索引边界。 */
export const reviewChecks = [
    "templateValueFocused",
    "playHypothesisGrounded",
    "slotRecallComplete",
    "slotPrecisionComplete",
    "semanticUnitsCoherent",
    "slotScopeMinimal",
    "imageModesJustified",
    "groupPolicyJustified",
    "featureAuthorityComplete",
    "textRoutingComplete",
    "textEditLayersComplete",
    "titlePortable",
    "copyUserFacingAndSearchable",
    "promptUserFacing",
    "placeholdersExact",
    "suggestionsSubstituteNaturally",
    "defaultsNaturalAndIdentitySpecific",
    "tagsValid",
    "visualContractRespectsInputs",
] as const;
export type TemplateValidationDiagnostic = Readonly<{
    path: string;
    code: string;
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
    textRegions layout position language exactText editValue semanticUnitId semanticUnitRole routingEvidence translationSourceRegionId
    imageObservation visualMechanism containers fixedStructure fieldEvidence promptCoverage allEditableContentCovered freeEditableRegionIds
    visualSelections evidenceIndex decision factRefs observations selections
    translationEquivalences sourceRegionId targetRegionIds sourceTextSha256 targetTextSha256 warnings
    semanticModel dynamicFactSources completeRedrawByTarget sourceIsolationByInput instanceIds
    defaultLanguageReview natural concise modifierMinimal inputModeDecision modes inheritFromUpload keepFromTemplate sourceIsolation
    sameAxis sameGranularity mechanismCompatible
    visualEvidence searchIntent category
    subjectIdentity species bodyForm pose expression clothing accessories color material
    key title description promptTemplate inputSchema version slots type text image
    presentation allowCustom defaultValue placeholder suggestions label required
    runtimeSemantics visualContract medium styleTraits composition relations colorAndLight
    inputBindings operation targetIds targetId targetInstances appearance targets role region
    metadata tags prompt needsReview rationale reason passed observation
    reviewedPlanSha256 reviewedDraftSha256 issues`
        .split(/\s+/)
        .concat([...reviewChecks]),
);
const codes = new Set(
    `invalid_type invalid_value invalid_format too_small too_big invalid_union
    unrecognized_keys invalid_key invalid_element not_multiple_of custom
    type required additionalProperties enum const minItems maxItems minLength maxLength
    pattern format oneOf anyOf allOf minimum maximum contract draft_semantics analysis_contract review_evidence invalid_schema digest_mismatch unresolved_review check_failed missing_reference fixed_text_missing invalid_target_scope missing_visual_coverage selection_coverage omitted_fact_frozen duplicate_fact target_fact_unreferenced`.split(
        /\s+/,
    ),
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
