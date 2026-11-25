/** 模板母版 v2 显式单次修图：按明确意图单次调用 gpt-image-2.6-sunburst 出图，经基础确定性校验后直接上传交付。 */
import { downloadSourcePhoto } from "../../business-api/source-photo.js";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../../process-runtime/index.js";
import { templateImageSize } from "../template-from-image/image.js";
import {
    MasterCapabilityError,
    type masterEditSizes,
    type TemplateMasterCapability,
    templateMasterV2ImageModel,
} from "./capability.js";
import { checkV2Printable } from "./checks.js";
import {
    type MasterV2Output,
    masterV2InputSchema,
    masterV2OutputSchema,
} from "./contract.js";
import { decodeRgba, encodePng } from "./light.js";
import { buildV2EditInstruction } from "./method.js";
import { EDIT_REFERENCE_MAX_SIDE } from "./thresholds.js";

/** v2 单次修图硬超时：单次读图 + 单次改图（200s）+ 单次上传（60s）并留余量。 */
export const templateMasterV2TimeoutMs = 360_000;

export function createTemplateMasterV2Registration(options: {
    capability: TemplateMasterCapability;
    loadSource?: (url: string, signal: AbortSignal) => Promise<Buffer>;
}): ProcessRegistration {
    return defineProcessRegistration({
        id: "template-master",
        version: "v2",
        timeoutMs: templateMasterV2TimeoutMs,
        inputSchema: masterV2InputSchema,
        outputSchema: masterV2OutputSchema,
        activities: [
            "master_source_loading",
            "master_generation",
            "master_upload",
        ],
        execute: async (input, context) => {
            const { signal } = context;

            let source: Buffer;
            try {
                source = await context.runActivity(
                    "master_source_loading",
                    async () => {
                        const bytes = await (
                            options.loadSource ?? downloadSourcePhoto
                        )(input.imageUrl, signal);
                        await decodeRgba(bytes, 64);
                        return bytes;
                    },
                );
            } catch {
                signal.throwIfAborted();
                return failProcess(
                    "DEPENDENCY_FAILURE",
                    "参考图片无法读取或解码",
                );
            }

            const reference = await decodeRgba(source, EDIT_REFERENCE_MAX_SIDE);
            const size = templateImageSize(
                await decodeRgba(source, 4096),
            ) as (typeof masterEditSizes)[number];
            const referencePng = await encodePng(reference);
            const prompt = buildV2EditInstruction({
                operation: input.operation,
                transparent: input.transparent,
                watermarkNote: input.watermarkNote,
                spec: input.template?.runtimeSemantics.designSpec,
            });

            let edited: Buffer;
            try {
                edited = await context.runActivity("master_generation", () =>
                    options.capability.edit({
                        image: referencePng,
                        prompt,
                        size,
                        model: templateMasterV2ImageModel,
                        quality: "medium",
                        background: input.transparent
                            ? "transparent"
                            : "opaque",
                        idempotencyKey: `${context.runId}-master-v2-1`,
                        signal,
                    }),
                );
            } catch (error) {
                signal.throwIfAborted();
                if (
                    error instanceof MasterCapabilityError &&
                    error.reason === "rejected"
                ) {
                    return failProcess(
                        "DEPENDENCY_FAILURE",
                        "图片服务明确拒绝了本次改图",
                    );
                }
                return failProcess(
                    "DEPENDENCY_FAILURE_AFTER_COMMIT",
                    "改图已派发但未返回可用结果，费用未知，请人工确认后再重试",
                );
            }

            const printable = await checkV2Printable(edited, input.transparent);
            if (!printable.passed) {
                return failProcess(
                    "MASTER_NOT_ACCEPTED",
                    `单次修图未通过基础可印校验：${printable.detail ?? "不可印"}`,
                );
            }

            let prepared: MasterV2Output["preparedImage"];
            try {
                prepared = await context.runActivity("master_upload", () =>
                    options.capability.upload(edited, signal),
                );
            } catch {
                signal.throwIfAborted();
                return failProcess(
                    "DEPENDENCY_FAILURE_AFTER_COMMIT",
                    "母版已生成但上传未完成",
                );
            }

            return {
                preparedImage: prepared,
                master: {
                    operation: input.operation,
                    transparent: input.transparent,
                    modelName: templateMasterV2ImageModel,
                    checks: {
                        printable: { passed: true },
                    },
                },
            } satisfies MasterV2Output;
        },
    });
}
