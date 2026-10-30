/** 编排模板生成与独立复核，复核直接补丁修正，结果不生图或入库。 */

import { AgentJsonSyntaxError } from "../../agent-runtime/pi.js";
import { isPublicHttpTargetPolicyError } from "../../network/public-http.js";
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
import { sourceAnalysisIssues } from "./quality.js";

export function createTemplateRegistration(options: {
    agent: TemplateAgent;
    loadImage?: TemplateImageLoader;
    onDiagnostic?: (record: TemplateDiagnostic) => void;
}): ProcessRegistration {
    if (
        typeof options.agent?.compile !== "function" ||
        typeof options.agent?.review !== "function"
    )
        throw new Error("模板 Agent 必须分别提供 compile 与独立 review");
    const loadImage = options.loadImage ?? loadTemplateImage;
    return defineProcessRegistration({
        id: "template-from-image",
        version: "v1",
        timeoutMs: 480_000,
        inputSchema: templateInputSchema,
        outputSchema: templateOutputSchema,
        activities: [
            "template_image_loading",
            "template_compilation",
            "template_correction",
            "template_review",
            "template_validation",
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
                );
            } catch (error) {
                return failProcess(
                    "DEPENDENCY_FAILURE",
                    isPublicHttpTargetPolicyError(error)
                        ? error.code === "PUBLIC_HTTP_TARGET_FORBIDDEN_ADDRESS"
                            ? "图片域名解析到了受限地址，请检查本机代理的 Fake-IP 或 DNS 配置"
                            : "图片地址解析失败，请检查地址与 DNS 配置"
                        : "参考图片无法读取，请检查图片地址、格式和尺寸",
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

            // 可读取计划的全部问题交给唯一的独立复核，避免单项错误先消耗一次修正。
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
            let reviewed: unknown;
            try {
                reviewed = await context.runActivity("template_review", () =>
                    options.agent.review({
                        image,
                        note: input.note,
                        plan,
                        issues: [...new Set(issues)],
                        signal: context.signal,
                    }),
                );
            } catch (error) {
                diagnose("review", 1, error);
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
                const candidate = readTemplateCandidate(reviewed);
                const review =
                    reviewed &&
                    typeof reviewed === "object" &&
                    "review" in reviewed
                        ? reviewed.review
                        : undefined;
                return {
                    template: await context.runActivity(
                        "template_validation",
                        async () =>
                            compileTemplateResult(
                                { ...candidate, review },
                                input.imageUrl,
                                image,
                            ),
                    ),
                };
            } catch (error) {
                diagnose("validation", 2, error);
                if (error instanceof TemplateContractError) {
                    return failProcess(
                        "AGENT_FAILURE",
                        "模板在独立复核修正后仍未通过校验，本次未生成可用模板",
                    );
                }
                const failure = templateExecutionFailure(error);
                return failProcess(
                    "AGENT_FAILURE",
                    `模板校验未完成：${failure.message}`,
                );
            }
        },
    });
}
