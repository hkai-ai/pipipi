/** 定义商品做同款（product-remix/v1）的 Process Registration：编排加载、分档规划、预算门禁、生成与 VLM 质检闭环及产物上传。 */
import { createHash } from "node:crypto";
import { AgentExecutionFailure } from "../../agent-runtime/failure.js";
import { downloadSourcePhoto } from "../../business-api/source-photo.js";
import { currentCostLedger } from "../../process-runtime/cost.js";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../../process-runtime/index.js";
import {
    evaluateRemixVerification,
    type ProductRemixAgent,
    type RemixPlan,
    type RemixVerification,
    remixPlanSchema,
    remixVerificationSchema,
} from "./agent.js";
import {
    type ProductRemixCapability,
    ProductRemixCapabilityError,
    type ProductRemixEditResult,
    type ProductRemixUploadedImage,
} from "./capability.js";
import {
    isProductRemixImageUrl,
    parseImageSize,
    productRemixInputSchema,
    productRemixOutputSchema,
    selectRemixImageSize,
} from "./contract.js";
import {
    type DecodedRemixImage,
    decodeRemixSourceImage,
    verifyGeneratedPng,
} from "./image.js";
import { buildRemixEditPrompt } from "./method.js";

/** 单次运行硬超时（11 分钟），低于 Memebuy 侧 900s 总超时，确保由 Pipipi 先落 PROCESS_TIMEOUT 终态。 */
export const productRemixTimeoutMs = 660_000;

const dependencyDiagnosticCodes = new Set([
    "connection",
    "timeout",
    "rate_limit",
    "authentication",
    "provider_unavailable",
    "provider_rejected",
    "configuration",
]);

function isUpstreamModelDependencyError(error: unknown): boolean {
    return (
        error instanceof AgentExecutionFailure &&
        dependencyDiagnosticCodes.has(error.diagnostic.code)
    );
}

function sha256Text(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function createProductRemixRegistration(options: {
    capability: ProductRemixCapability;
    agent: ProductRemixAgent;
    loadSource?: (url: string, signal: AbortSignal) => Promise<Buffer>;
    /** 已知费用累计；缺省读取本次运行的费用账本。 */
    spentUsd?: () => number;
}): ProcessRegistration {
    const loadSource = options.loadSource ?? downloadSourcePhoto;
    const spent =
        options.spentUsd ?? (() => currentCostLedger()?.snapshot().usd ?? 0);

    return defineProcessRegistration({
        id: "product-remix",
        version: "v1",
        timeoutMs: productRemixTimeoutMs,
        inputSchema: productRemixInputSchema,
        outputSchema: productRemixOutputSchema,
        activities: [
            "remix_source_loading",
            "remix_planning",
            "remix_generation",
            "remix_verification",
            "remix_upload",
        ],
        execute: async (input, context) => {
            const { signal } = context;

            let source: DecodedRemixImage;
            const referenceUrls =
                input.referenceImageUrls ??
                (input.referenceImageUrl ? [input.referenceImageUrl] : []);
            let references: DecodedRemixImage[];
            try {
                const loaded = await context.runActivity(
                    "remix_source_loading",
                    async () => {
                        const sourceBytes = await loadSource(
                            input.sourceImageUrl,
                            signal,
                        );
                        const decodedSource =
                            await decodeRemixSourceImage(sourceBytes);
                        const decodedReferences: DecodedRemixImage[] = [];
                        for (const url of referenceUrls) {
                            decodedReferences.push(
                                await decodeRemixSourceImage(
                                    await loadSource(url, signal),
                                ),
                            );
                        }
                        return { decodedSource, decodedReferences };
                    },
                );
                source = loaded.decodedSource;
                references = loaded.decodedReferences;
            } catch {
                signal.throwIfAborted();
                return failProcess(
                    "INVALID_INPUT",
                    "输入参考图片无法读取或格式不受支持",
                );
            }

            const explicitSize = input.imageSize
                ? parseImageSize(input.imageSize)
                : undefined;
            if (input.imageSize && !explicitSize) {
                return failProcess("INVALID_INPUT", "目标图片尺寸格式无效");
            }
            const targetSize = selectRemixImageSize(
                explicitSize ?? { width: source.width, height: source.height },
            );

            signal.throwIfAborted();
            if (spent() >= input.budget.maxUsd) {
                return failProcess(
                    "AGENT_FAILURE",
                    "费用预算已用尽，未产出通过质检的印花图",
                );
            }

            let plan: RemixPlan;
            try {
                plan = await context.runActivity("remix_planning", async () =>
                    remixPlanSchema.parse(
                        await options.agent.plan({
                            sourceView: source.view,
                            referenceViews: references.map(
                                (image) => image.view,
                            ),
                            userText: input.userText,
                            targetSize,
                            canRetry: () => spent() < input.budget.maxUsd,
                            signal,
                        }),
                    ),
                );
            } catch (error) {
                signal.throwIfAborted();
                if (isUpstreamModelDependencyError(error)) {
                    return failProcess(
                        "DEPENDENCY_FAILURE",
                        "上游多模态理解服务异常",
                    );
                }
                return failProcess(
                    "AGENT_FAILURE",
                    "改图意图理解与方案规划失败",
                );
            }

            let lastIssues: readonly string[] | undefined;
            let hasCandidate = false;
            const images = [source, ...references].map((image) => ({
                bytes: image.editPng,
                mimeType: "image/png" as const,
            }));
            for (
                let attempt = 1;
                attempt <= input.budget.maxAttempts;
                attempt += 1
            ) {
                signal.throwIfAborted();
                if (spent() >= input.budget.maxUsd) {
                    return failProcess(
                        "AGENT_FAILURE",
                        "费用预算已用尽，未产出通过质检的印花图",
                    );
                }

                const prompt = buildRemixEditPrompt({
                    plan,
                    referenceCount: references.length,
                    targetSize,
                    retryFeedback: lastIssues,
                });

                let generated: ProductRemixEditResult;
                try {
                    generated = await context.runActivity(
                        "remix_generation",
                        () =>
                            options.capability.edit({
                                images,
                                prompt,
                                size: targetSize,
                                idempotencyKey: `${context.runId}-remix-${attempt}`,
                                signal,
                            }),
                    );
                } catch (error) {
                    signal.throwIfAborted();
                    if (error instanceof ProductRemixCapabilityError) {
                        if (error.reason === "rejected") {
                            lastIssues = [
                                ...(lastIssues ?? []),
                                "图像模型拒绝了本次生成指令，请调整表达后重试",
                            ];
                            if (
                                attempt === input.budget.maxAttempts &&
                                !hasCandidate
                            ) {
                                return failProcess(
                                    "DEPENDENCY_FAILURE",
                                    "上游图像生成服务拒绝了本次请求",
                                );
                            }
                            continue;
                        }
                        return failProcess(
                            "DEPENDENCY_FAILURE",
                            "上游图像生成服务异常",
                        );
                    }
                    throw error;
                }
                hasCandidate = true;

                let verifiedImage: Awaited<
                    ReturnType<typeof verifyGeneratedPng>
                >;
                try {
                    verifiedImage = await verifyGeneratedPng(generated.bytes);
                } catch {
                    return failProcess(
                        "INVALID_OUTPUT",
                        "生成图片字节校验失败",
                    );
                }

                signal.throwIfAborted();
                if (spent() >= input.budget.maxUsd) {
                    return failProcess(
                        "AGENT_FAILURE",
                        "费用预算已用尽，未能在预算内完成质检确认",
                    );
                }

                let verification: RemixVerification;
                try {
                    verification = await context.runActivity(
                        "remix_verification",
                        async () =>
                            remixVerificationSchema.parse(
                                await options.agent.verify({
                                    sourceView: source.view,
                                    referenceViews: references.map(
                                        (image) => image.view,
                                    ),
                                    candidateView: verifiedImage.view,
                                    userText: input.userText,
                                    plan,
                                    canRetry: () =>
                                        spent() < input.budget.maxUsd,
                                    signal,
                                }),
                            ),
                    );
                } catch (error) {
                    signal.throwIfAborted();
                    if (isUpstreamModelDependencyError(error)) {
                        return failProcess(
                            "DEPENDENCY_FAILURE",
                            "上游多模态质检服务异常",
                        );
                    }
                    return failProcess(
                        "AGENT_FAILURE",
                        "视觉质检未能产出有效结论",
                    );
                }

                const verdict = evaluateRemixVerification(verification);
                if (!verdict.passed) {
                    lastIssues = verdict.issues;
                    continue;
                }

                let uploaded: ProductRemixUploadedImage;
                try {
                    uploaded = await context.runActivity("remix_upload", () =>
                        options.capability.upload(generated.bytes, signal),
                    );
                } catch {
                    signal.throwIfAborted();
                    return failProcess(
                        "DEPENDENCY_FAILURE",
                        "成图上传至产物存储失败",
                    );
                }

                const outputUrlDigest = sha256Text(uploaded.url);
                const sourceUrlDigest = sha256Text(input.sourceImageUrl);
                if (
                    !isProductRemixImageUrl(uploaded.url) ||
                    outputUrlDigest === sourceUrlDigest ||
                    referenceUrls.some(
                        (url) => sha256Text(url) === outputUrlDigest,
                    )
                ) {
                    return failProcess(
                        "INVALID_OUTPUT",
                        "成图地址未通过安全与独立性校验",
                    );
                }

                return {
                    image: {
                        url: uploaded.url,
                        width: uploaded.width,
                        height: uploaded.height,
                    },
                    modelName: generated.modelName,
                    resolvedTier: plan.tier,
                };
            }

            return failProcess(
                "AGENT_FAILURE",
                `已尝试 ${input.budget.maxAttempts} 次仍未产出通过质检的印花图`,
            );
        },
    });
}
