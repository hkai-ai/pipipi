/** 编排模板生成与独立复核，复核直接补丁修正，结果不生图或入库。 */

import { agentDiagnostic } from "../../agent-runtime/diagnostics.js";
import { AgentJsonSyntaxError } from "../../agent-runtime/pi.js";
import { isPublicHttpTargetPolicyError } from "../../network/public-http.js";
import {
    type ActivityDiagnostic,
    dependencyDiagnostic,
} from "../../process-runtime/diagnostics.js";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../../process-runtime/index.js";
import type { TemplateAgent } from "./agent.js";
import {
    compileTemplateResult,
    parseTemplateCandidate,
    readTemplateCandidate,
    TemplateContractError,
    templateInputSchema,
    templateOutputSchema,
    templateSemanticIssues,
    templateV3OutputSchema,
} from "./contract.js";
import {
    type TemplateDiagnostic,
    validationDiagnostics,
} from "./diagnostics.js";
import { templateExecutionFailure } from "./failure.js";
import { loadTemplateImage, type TemplateImageLoader } from "./image.js";
import {
    draftFromPlan,
    materializeTemplatePlan,
    readTemplatePlan,
    TemplateProjectionError,
} from "./projection.js";
import { candidateDigest, sourceAnalysisIssues } from "./quality.js";

// 仅修正已形成候选、可由字段补丁处理的问题；身份、摘要或调用错误直接失败。
const repairableRules = new Set([
    "unresolved_review",
    "check_failed",
    "review_evidence",
    "draft_semantics",
    "analysis_contract",
    "missing_reference",
    "fixed_text_missing",
    "invalid_target_scope",
    "missing_visual_coverage",
    "selection_coverage",
    "omitted_fact_frozen",
    "duplicate_fact",
    "target_fact_unreferenced",
]);

export function createTemplateRegistration(options: {
    agent: TemplateAgent;
    runtimeVersion?: 2 | 3;
    loadImage?: TemplateImageLoader;
    onDiagnostic?: (record: TemplateDiagnostic) => void;
}): ProcessRegistration {
    if (
        typeof options.agent?.compile !== "function" ||
        typeof options.agent?.review !== "function"
    )
        throw new Error("模板 Agent 必须分别提供 compile 与独立 review");
    const loadImage = options.loadImage ?? loadTemplateImage;
    const version = options.runtimeVersion ?? 2;
    return defineProcessRegistration({
        id: "template-from-image",
        version: version === 3 ? "v2" : "v1",
        timeoutMs: 480_000,
        inputSchema: templateInputSchema,
        outputSchema:
            version === 3 ? templateV3OutputSchema : templateOutputSchema,
        activities: [
            "template_image_loading",
            "template_compilation",
            "template_correction",
            "template_review",
            "template_validation",
            "template_review_correction",
        ],
        execute: async (input, context) => {
            const diagnose = (
                stage: TemplateDiagnostic["stage"],
                attempt: number,
                error: unknown,
            ) => {
                try {
                    options.onDiagnostic?.({
                        event: "template_diagnostic",
                        runId: context.runId,
                        stage,
                        attempt,
                        category:
                            error instanceof AgentJsonSyntaxError
                                ? "json_syntax"
                                : error instanceof TemplateProjectionError
                                  ? "structure"
                                  : error instanceof TemplateContractError
                                    ? "contract"
                                    : "execution",
                        issues:
                            error instanceof TemplateContractError
                                ? validationDiagnostics(
                                      error.diagnostics.map((issue) => ({
                                          path: issue.path
                                              .split("/")
                                              .filter(Boolean)
                                              .map((part) =>
                                                  /^\d+$/.test(part)
                                                      ? Number(part)
                                                      : part,
                                              ),
                                          code: issue.code,
                                      })),
                                  )
                                : [],
                    });
                } catch {
                    // 诊断失败不消耗修正预算，也不改变业务结果。
                }
            };
            let image: Awaited<ReturnType<TemplateImageLoader>>;
            try {
                image = await context.runActivity(
                    "template_image_loading",
                    () => loadImage(input.imageUrl, context.signal),
                    () => dependencyDiagnostic(true),
                );
            } catch (error) {
                return failProcess(
                    "DEPENDENCY_FAILURE",
                    isPublicHttpTargetPolicyError(error)
                        ? error.code === "PUBLIC_HTTP_TARGET_FORBIDDEN_ADDRESS"
                            ? "图片域名解析到了受限地址"
                            : "图片地址解析失败"
                        : "参考图片无法读取或解码",
                );
            }
            let plan: ReturnType<typeof readTemplatePlan> | undefined;
            let correction:
                | { previous: unknown; issues: readonly string[] }
                | undefined;
            for (let attempt = 0; attempt < 2; attempt++) {
                context.signal.throwIfAborted();
                let output: unknown;
                try {
                    output = await context.runActivity(
                        attempt === 0
                            ? "template_compilation"
                            : "template_correction",
                        () =>
                            options.agent.compile({
                                image,
                                note: input.note,
                                correction,
                                signal: context.signal,
                            }),
                        templateActivityDiagnostic,
                    );
                } catch (error) {
                    diagnose(
                        attempt === 0 ? "compilation" : "correction",
                        attempt + 1,
                        error,
                    );
                    if (
                        error instanceof TemplateProjectionError &&
                        (JSON.stringify(error.previous)?.length ?? Infinity) <=
                            100_000
                    ) {
                        correction = {
                            previous: error.previous,
                            issues: error.issues,
                        };
                        continue;
                    }
                    if (
                        error instanceof AgentJsonSyntaxError &&
                        error.responseText.length <= 100_000
                    ) {
                        correction = {
                            previous: error.responseText,
                            issues: [
                                "上一版不是合法 JSON；返回完整的 analysis、draft 计划，不包含复核报告。",
                            ],
                        };
                        continue;
                    }
                    const failure = templateExecutionFailure(error);
                    return failProcess(
                        "AGENT_FAILURE",
                        `模板编译未完成：${failure.message}`,
                    );
                }
                if ((JSON.stringify(output)?.length ?? Infinity) > 100_000)
                    return failProcess(
                        "AGENT_FAILURE",
                        "模板编译结果超出限制，本次未生成可用模板",
                    );
                try {
                    plan = readTemplatePlan(output);
                    if (
                        draftFromPlan(plan).runtimeSemantics.version !== version
                    ) {
                        plan = undefined;
                        throw new TemplateContractError([
                            `runtimeSemantics.version 必须为 ${version}`,
                        ]);
                    }
                    break;
                } catch (error) {
                    if (!(error instanceof TemplateContractError)) throw error;
                    diagnose(
                        attempt === 0 ? "compilation" : "correction",
                        attempt + 1,
                        error,
                    );
                    correction = { previous: output, issues: error.issues };
                }
            }
            if (!plan)
                return failProcess(
                    "AGENT_FAILURE",
                    "模板编译结果无法读取，本次未生成可用模板",
                );

            // 可读取计划的全部问题交给独立复核，避免单项错误先消耗一次修正。
            const issues = [
                ...templateSemanticIssues(draftFromPlan(plan)),
                ...sourceAnalysisIssues(draftFromPlan(plan), plan.analysis),
            ];
            try {
                parseTemplateCandidate(materializeTemplatePlan(plan));
            } catch (error) {
                if (!(error instanceof TemplateContractError)) throw error;
                diagnose("validation", 1, error);
                issues.push(...error.issues);
            }
            let reviewPlan = plan;
            let repair:
                | { error: TemplateContractError; unchangedDigest?: string }
                | undefined;
            for (;;) {
                context.signal.throwIfAborted();
                let patchedPlan: typeof reviewPlan | undefined;
                let reviewed: unknown;
                try {
                    reviewed = await context.runActivity(
                        repair
                            ? "template_review_correction"
                            : "template_review",
                        () =>
                            options.agent.review({
                                image,
                                note: input.note,
                                plan: reviewPlan,
                                onPatchedPlan: (updated) => {
                                    patchedPlan = updated;
                                },
                                issues: repair?.error.issues ?? [
                                    ...new Set(issues),
                                ],
                                signal: context.signal,
                            }),
                        templateActivityDiagnostic,
                    );
                } catch (error) {
                    diagnose("review", repair ? 2 : 1, error);
                    if (error instanceof TemplateContractError) {
                        return failProcess(
                            "AGENT_FAILURE",
                            "独立复核结果未通过校验，本次未生成可用模板",
                        );
                    }
                    const failure = templateExecutionFailure(error);
                    return failProcess(
                        "AGENT_FAILURE",
                        `模板独立复核未完成：${failure.message}`,
                    );
                }
                try {
                    const template = await context.runActivity(
                        "template_validation",
                        async () => {
                            const candidate = readTemplateCandidate(reviewed);
                            if (
                                repair?.unchangedDigest ===
                                candidateDigest(candidate)
                            )
                                throw repair.error;
                            if (
                                candidate.draft.runtimeSemantics.version !==
                                version
                            )
                                throw new TemplateContractError(
                                    [
                                        `runtimeSemantics.version 必须为 ${version}`,
                                    ],
                                    [
                                        {
                                            path: "/draft/runtimeSemantics/version",
                                            code: "const",
                                        },
                                    ],
                                );
                            const review =
                                reviewed &&
                                typeof reviewed === "object" &&
                                "review" in reviewed
                                    ? reviewed.review
                                    : undefined;
                            return compileTemplateResult(
                                { ...candidate, review },
                                input.imageUrl,
                                image,
                            );
                        },
                        templateValidationDiagnostic,
                    );
                    return { template };
                } catch (error) {
                    diagnose("validation", repair ? 3 : 2, error);
                    if (
                        version === 3 &&
                        !repair &&
                        patchedPlan &&
                        error instanceof TemplateContractError &&
                        error.diagnostics.length &&
                        error.diagnostics.every((issue) =>
                            repairableRules.has(issue.code),
                        )
                    ) {
                        repair = {
                            error,
                            unchangedDigest: error.diagnostics.some(
                                (issue) => issue.code === "unresolved_review",
                            )
                                ? candidateDigest(
                                      readTemplateCandidate(reviewed),
                                  )
                                : undefined,
                        };
                        reviewPlan = patchedPlan;
                        continue;
                    }
                    if (
                        error instanceof TemplateContractError ||
                        error instanceof TemplateProjectionError
                    ) {
                        return failProcess(
                            "AGENT_FAILURE",
                            "模板在独立复核修正后仍未通过校验，本次未生成可用模板",
                        );
                    }
                    throw error;
                }
            }
        },
    });
}

function templateActivityDiagnostic(error: unknown): ActivityDiagnostic {
    return error instanceof TemplateContractError
        ? templateValidationDiagnostic(error)
        : agentDiagnostic(error);
}

function templateValidationDiagnostic(error: unknown): ActivityDiagnostic {
    return error instanceof TemplateContractError
        ? {
              stage: "schema",
              code: "invalid_contract",
              ...(error.diagnostics.length
                  ? { issues: error.diagnostics }
                  : {}),
          }
        : { stage: "execution", code: "internal_failure" };
}
