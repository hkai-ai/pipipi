/** 将批准图编译为印花语义 v4 候选，独立复核后才交付，旧编译流程保持独立。 */
import { agentDiagnostic } from "../../../agent-runtime/diagnostics.js";
import { AgentExecutionFailure } from "../../../agent-runtime/failure.js";
import { AgentJsonSyntaxError } from "../../../agent-runtime/pi.js";
import { dependencyDiagnostic } from "../../../process-runtime/diagnostics.js";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../../../process-runtime/index.js";
import { validationDiagnostics } from "../../../process-runtime/template-diagnostics.js";
import { templateInputSchema } from "../contract.js";
import { loadTemplateImage, type TemplateImageLoader } from "../image.js";
import type { PrintDesignAgent } from "./agent.js";
import {
    candidateIssues,
    compileResult,
    PrintDesignContractError,
    printDesignOutputSchema,
    readCandidate,
} from "./contract.js";
import { applyReview, type SkippedPatch } from "./review.js";
export function createPrintDesignRegistration(options: {
    agent: PrintDesignAgent;
    loadImage?: TemplateImageLoader;
}): ProcessRegistration {
    return defineProcessRegistration({
        id: "template-from-image",
        version: "v3",
        timeoutMs: 480000,
        inputSchema: templateInputSchema,
        outputSchema: printDesignOutputSchema,
        activities: [
            "template_image_loading",
            "template_compilation",
            "template_correction",
            "template_review",
            "template_validation",
        ],
        execute: async (input, context) => {
            let image: Awaited<ReturnType<TemplateImageLoader>>;
            try {
                image = await context.runActivity(
                    "template_image_loading",
                    () =>
                        (options.loadImage ?? loadTemplateImage)(
                            input.imageUrl,
                            context.signal,
                        ),
                    () => dependencyDiagnostic(true),
                );
            } catch {
                return failProcess(
                    "DEPENDENCY_FAILURE",
                    "参考图片无法读取或解码",
                );
            }
            const request = { image, note: input.note, signal: context.signal };
            let candidate: ReturnType<typeof readCandidate> | undefined;
            let correction:
                | { previous: unknown; issues: readonly string[] }
                | undefined;
            for (let attempt = 0; attempt < 2; attempt++) {
                context.signal.throwIfAborted();
                let raw: unknown;
                try {
                    candidate = await context.runActivity(
                        attempt
                            ? "template_correction"
                            : "template_compilation",
                        async () => {
                            raw = await options.agent.compile({
                                ...request,
                                correction,
                            });
                            if (
                                (JSON.stringify(raw)?.length ?? Infinity) >
                                100000
                            )
                                throw new AgentExecutionFailure({
                                    stage: "schema",
                                    code: "invalid_contract",
                                    issues: [{ path: "/", code: "too_big" }],
                                });
                            return readCandidate(raw);
                        },
                        (error) =>
                            error instanceof PrintDesignContractError
                                ? error.diagnostic
                                : agentDiagnostic(error),
                    );
                    break;
                } catch (error) {
                    if (error instanceof PrintDesignContractError)
                        correction = { previous: raw, issues: error.issues };
                    else if (
                        error instanceof AgentJsonSyntaxError &&
                        error.responseText.length <= 100000
                    )
                        correction = {
                            previous: error.responseText,
                            issues: [
                                "只修正 JSON 格式，返回完整 observation 与 draft",
                            ],
                        };
                    else if (error instanceof AgentExecutionFailure)
                        return failProcess(
                            "AGENT_FAILURE",
                            "印花模板编译未完成",
                        );
                    else throw error;
                }
            }
            if (!candidate)
                return failProcess("AGENT_FAILURE", "印花模板候选结构无法读取");
            const accepted = candidate;
            try {
                const review = await context.runActivity(
                    "template_review",
                    () =>
                        options.agent.review({
                            ...request,
                            candidate: structuredClone(accepted),
                            issues: candidateIssues(accepted),
                        }),
                    agentDiagnostic,
                );
                let skipped: readonly SkippedPatch[] = [];
                return await context.runActivity(
                    "template_validation",
                    async () => {
                        const merged = applyReview(accepted, review);
                        skipped = merged.skipped;
                        return compileResult(
                            merged.candidate,
                            input.imageUrl,
                            image,
                        );
                    },
                    (error) =>
                        error instanceof PrintDesignContractError
                            ? {
                                  ...error.diagnostic,
                                  issues: [
                                      // 被跳过的补丁只记下标与规则码，排在前面避免被截断。
                                      ...validationDiagnostics(
                                          skipped
                                              .slice(0, 4)
                                              .map(({ index, code }) => ({
                                                  path: [
                                                      "review",
                                                      "changes",
                                                      index,
                                                      "path",
                                                  ],
                                                  code,
                                              })),
                                      ),
                                      ...error.diagnostic.issues,
                                  ],
                              }
                            : { stage: "execution", code: "internal_failure" },
                );
            } catch (error) {
                if (error instanceof PrintDesignContractError)
                    return failProcess(
                        "AGENT_FAILURE",
                        "印花模板在独立复核后仍未通过校验",
                    );
                // 模型依赖异常由受控活动保留诊断；不追加调用。
                if (error instanceof AgentExecutionFailure)
                    return failProcess(
                        "AGENT_FAILURE",
                        "印花模板独立复核未完成",
                    );
                throw error;
            }
        },
    });
}
