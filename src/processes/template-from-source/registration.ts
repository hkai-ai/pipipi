/** 分离策略、审核后生图和审核后编译，人工暂停不占用 Process 等待预算。 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessAttemptRunner,
    type ProcessRegistration,
} from "../../process-runtime/index.js";
import {
    templateInputSchema,
    templateOutputSchema,
} from "../template-from-image/contract.js";
import {
    loadTemplateImage,
    type TemplateImageLoader,
} from "../template-from-image/image.js";
import type { TemplateStrategyAgent } from "./agent.pi.js";
import {
    approvalSchema,
    digestSchema,
    imageApprovalSchema,
    imageReviewSchema,
    preparedTemplateImageSchema,
    productionIdSchema,
    type TemplateImagePreparation,
} from "./capability.js";
import { applyStrategyCorrection } from "./correction.js";
import {
    parseReplacementStrategy,
    type ReplacementStrategy,
    replacementStrategySchema,
    type StrategyIssue,
    StrategyValidationError,
} from "./strategy.js";
export type StrategyDiagnostic = Readonly<{
    event: "template_strategy_diagnostic";
    runId: string;
    stage: string;
    issues: readonly StrategyIssue[];
}>;
export const planOutputSchema = z.strictObject({
    productionId: productionIdSchema,
    strategySha256: digestSchema,
    sourceImageSha256: digestSchema,
    strategy: replacementStrategySchema,
});
export function createTemplatePlanRegistration(options: {
    agent: TemplateStrategyAgent;
    preparation: TemplateImagePreparation;
    loadImage?: TemplateImageLoader;
    onDiagnostic?: (record: StrategyDiagnostic) => void;
}): ProcessRegistration {
    return defineProcessRegistration({
        id: "template-image-plan",
        version: "v1",
        timeoutMs: 240000,
        inputSchema: templateInputSchema,
        outputSchema: planOutputSchema,
        activities: [
            "source_loading",
            "replacement_planning",
            "plan_validation",
            "plan_correction",
            "plan_persistence",
        ],
        execute: async (input, context) => {
            let stage = "source_loading";
            const diagnose = (error: unknown) => {
                try {
                    options.onDiagnostic?.({
                        event: "template_strategy_diagnostic",
                        runId: context.runId,
                        stage,
                        issues:
                            error instanceof StrategyValidationError
                                ? error.issues.slice(0, 16)
                                : [],
                    });
                } catch {
                    // 诊断 Sink 失败不改变业务结果和修正预算。
                }
            };
            try {
                const image = await context.runActivity("source_loading", () =>
                    (options.loadImage ?? loadTemplateImage)(
                        input.imageUrl,
                        context.signal,
                    ),
                );
                stage = "replacement_planning";
                const candidate = await context.runActivity(
                    "replacement_planning",
                    () => options.agent.plan(image, context.signal, input.note),
                );
                stage = "plan_validation";
                let strategy: ReplacementStrategy;
                try {
                    strategy = await context.runActivity(
                        "plan_validation",
                        async () => parseReplacementStrategy(candidate),
                    );
                } catch (error) {
                    const repair = options.agent.repair?.bind(options.agent);
                    if (
                        !(error instanceof StrategyValidationError) ||
                        !repair ||
                        !candidate ||
                        typeof candidate !== "object" ||
                        Array.isArray(candidate) ||
                        error.issues.some((issue) => !issue.fields.length) ||
                        JSON.stringify(candidate).length > 250_000 ||
                        context.signal.aborted
                    )
                        throw error;
                    diagnose(error);
                    stage = "plan_correction";
                    strategy = await context.runActivity(
                        "plan_correction",
                        async () => {
                            const patch = await repair(
                                image,
                                candidate,
                                error.issues,
                                context.signal,
                                input.note,
                            );
                            context.signal.throwIfAborted();
                            return applyStrategyCorrection(
                                candidate,
                                error.issues,
                                patch,
                            );
                        },
                    );
                }
                context.signal.throwIfAborted();
                stage = "plan_persistence";
                return planOutputSchema.parse(
                    await context.runActivity("plan_persistence", () =>
                        options.preparation.savePlan(
                            {
                                productionId: randomUUID(),
                                sourceImageUrl: input.imageUrl,
                                analyzedImageSha256: createHash("sha256")
                                    .update(Buffer.from(image.data, "base64"))
                                    .digest("hex"),
                                strategy,
                                note: input.note ?? null,
                            },
                            context.signal,
                        ),
                    ),
                );
            } catch (error) {
                diagnose(error);
                return failProcess(
                    "AGENT_FAILURE",
                    "替换方案未通过校验或保存，未提交图片生成",
                );
            }
        },
    });
}
export function createTemplateRenderRegistration(
    preparation: TemplateImagePreparation,
): ProcessRegistration {
    return defineProcessRegistration({
        id: "template-image-render",
        version: "v1",
        outputMaxBytes: 28_000_000,
        timeoutMs: 270000,
        inputSchema: approvalSchema,
        outputSchema: imageReviewSchema,
        activities: ["approved_image_rendering"],
        execute: async (input, context) => {
            try {
                return imageReviewSchema.parse(
                    await context.runActivity("approved_image_rendering", () =>
                        preparation.render(input, context.signal),
                    ),
                );
            } catch {
                return failProcess(
                    "DEPENDENCY_FAILURE_AFTER_COMMIT",
                    "成图未完成；请恢复同一生产项，不自动重新付费",
                );
            }
        },
    });
}
export function createTemplateSourceRegistration(options: {
    compiler: ProcessRegistration;
    attemptRunner: ProcessAttemptRunner;
    preparation: TemplateImagePreparation;
}): ProcessRegistration {
    return defineProcessRegistration({
        id: "template-from-source",
        version: "v1",
        timeoutMs: 570000,
        inputSchema: imageApprovalSchema,
        outputSchema: templateOutputSchema.extend({
            coverImageUrl: preparedTemplateImageSchema.shape.url,
            preparedImage: preparedTemplateImageSchema,
        }),
        activities: ["approved_image_upload", "approved_image_compilation"],
        execute: async (input, context) => {
            try {
                const image = await context.runActivity(
                    "approved_image_upload",
                    () => options.preparation.finalize(input, context.signal),
                );
                const accepted = options.compiler.accept({
                    imageUrl: image.url,
                    ...(image.note ? { note: image.note } : {}),
                });
                if (!accepted.accepted) throw new Error("输入不符合编译合同");
                const result = await context.runActivity(
                    "approved_image_compilation",
                    () =>
                        options.attemptRunner.run({
                            runId: `${context.runId}:compile`,
                            registration: options.compiler,
                            acceptedInput: accepted.acceptedInput,
                            signal: context.signal,
                        }),
                );
                if (result.status !== "succeeded")
                    throw new Error("编译未完成");
                return {
                    ...templateOutputSchema.parse(result.output),
                    coverImageUrl: image.url,
                    preparedImage: preparedTemplateImageSchema.parse({
                        url: image.url,
                        sha256: image.sha256,
                        width: image.width,
                        height: image.height,
                        contentType: image.contentType,
                    }),
                };
            } catch {
                return failProcess(
                    "DEPENDENCY_FAILURE_AFTER_COMMIT",
                    "审核图片的上传或编译未完成；重试复用同一图片，不重新生图",
                );
            }
        },
    });
}
