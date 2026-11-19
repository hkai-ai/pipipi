/** 将批准图编译为印花语义 v4 候选，首轮校验通过直接交付，违规则有界修正一次。 */
import { agentDiagnostic } from "../../../agent-runtime/diagnostics.js";
import { AgentExecutionFailure } from "../../../agent-runtime/failure.js";
import { AgentJsonSyntaxError } from "../../../agent-runtime/pi.js";
import { dependencyDiagnostic } from "../../../process-runtime/diagnostics.js";
import {
    defineProcessRegistration,
    failProcess,
    type ProcessRegistration,
} from "../../../process-runtime/index.js";
import { templateInputSchema } from "../contract.js";
import { loadTemplateImage, type TemplateImageLoader } from "../image.js";
import type { PrintDesignAgent } from "./agent.js";
import {
    compileResult,
    PrintDesignContractError,
    printDesignOutputSchema,
    readCandidate,
} from "./contract.js";

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
            let correction:
                | { previous: unknown; issues: readonly string[] }
                | undefined;
            let sawSyntaxFailure = false;
            for (let attempt = 0; attempt < 2; attempt++) {
                context.signal.throwIfAborted();
                let raw: unknown;
                try {
                    return await context.runActivity(
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
                            const candidate = readCandidate(raw);
                            return compileResult(
                                candidate,
                                input.imageUrl,
                                image,
                            );
                        },
                        (error) =>
                            error instanceof PrintDesignContractError
                                ? error.diagnostic
                                : agentDiagnostic(error),
                    );
                } catch (error) {
                    if (error instanceof PrintDesignContractError) {
                        sawSyntaxFailure = false;
                        correction = { previous: raw, issues: error.issues };
                    } else if (
                        error instanceof AgentJsonSyntaxError &&
                        error.responseText.length <= 100000
                    ) {
                        sawSyntaxFailure = true;
                        correction = {
                            previous: error.responseText,
                            issues: [
                                "只修正 JSON 格式，返回完整 observation 与 draft",
                            ],
                        };
                    } else if (error instanceof AgentExecutionFailure) {
                        return failProcess(
                            "AGENT_FAILURE",
                            "印花模板编译未完成",
                        );
                    } else {
                        throw error;
                    }
                }
            }
            return failProcess(
                "AGENT_FAILURE",
                sawSyntaxFailure
                    ? "印花模板候选结构无法读取"
                    : "印花模板候选未通过校验",
            );
        },
    });
}
