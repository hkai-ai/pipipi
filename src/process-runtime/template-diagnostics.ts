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

// 新增分析语义规则与原有 analysis_contract 共用一次复核修正机会。
export const analysisRuleCodes = [
    "analysis_gate_failed",
    "coverage_mismatch",
    "value_mismatch",
    "duplicate_id",
    "backend_fact_exposure",
    "missing_selected_candidate",
    "open_fact_frozen",
    "missing_evidence",
    "target_binding_mismatch",
    "route_mismatch",
    "unexpected_binding",
    "watermark_retained",
    "ambiguous_text_unreviewed",
    "open_identity_frozen",
    "invalid_region_reference",
    "identity_name_mismatch",
    "text_too_long",
    "language_mismatch",
    "conflicting_ownership",
    "free_text_missing",
    "removed_text_retained",
    "unresolved_text",
] as const;

// 只保留固定合同字段；槽位、标签、组件等模型生成的键统一隐藏。
const fields = new Set(
    `analysis draft review checks changes path value valueJson
    titleEvidence descriptionEvidence mediumComposition playDecisionModel coreUserDecisions decisionId slotId slotIds
    identityTopology identityId componentId openVisualFacts imageRationale identityRecognition name groupDecision
    action identity body ageStage hair selectionReason
    subject object prop scene nested_content
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
    pattern format oneOf anyOf allOf minimum maximum contract draft_semantics analysis_contract review_evidence invalid_schema digest_mismatch unresolved_review check_failed missing_reference fixed_text_missing invalid_target_scope missing_visual_coverage selection_coverage omitted_fact_frozen duplicate_fact target_fact_unreferenced`
        .split(/\s+/)
        .concat(analysisRuleCodes),
);

// 这些对象的键来自业务数据，即使键名刚好与静态合同字段相同也不得输出。
const dynamicKeys = new Set([
    "slotEvidence",
    "tagEvidence",
    "targetScopes",
    "inputBindings",
    "dynamicFactSources",
    "completeRedrawByTarget",
    "sourceIsolationByInput",
    "targetTextSha256",
]);

export function validationDiagnostics(
    issues: readonly Readonly<{ path: readonly PropertyKey[]; code: string }>[],
): readonly TemplateValidationDiagnostic[] {
    return issues.slice(0, 16).map((issue) => ({
        path: `/${issue.path
            .slice(0, 20)
            .map((part, index, path) => {
                if (dynamicKeys.has(String(path[index - 1]))) return "*";
                if (typeof part === "number")
                    return Number.isInteger(part) && part >= 0 && part <= 10_000
                        ? part
                        : "*";
                return typeof part === "string" && fields.has(part)
                    ? part
                    : "*";
            })
            .join("/")}`,
        code: codes.has(issue.code) ? issue.code : "contract",
    }));
}
