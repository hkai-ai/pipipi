/** 母版分档生成：轻、中、重逐档出图并逐次对照校验，通过的母版上传后返回。 */
import sharp from "sharp";
import { agentDiagnostic } from "../../agent-runtime/diagnostics.js";
import { downloadSourcePhoto } from "../../business-api/source-photo.js";
import { currentCostLedger } from "../../process-runtime/cost.js";
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
} from "./capability.js";
import {
    checkPalette,
    checkPrintable,
    checkSimilarity,
    deltaE,
    paletteOf,
    srgbToLab,
} from "./checks.js";
import {
    isSourceRunMasterInput,
    type MasterFailure,
    type MasterOutput,
    masterInputSchema,
    masterOutputSchema,
    type ResolvedMasterInput,
} from "./contract.js";
import {
    decodeRgba,
    edgeColor,
    encodePng,
    hasTransparentPixel,
    keyOutEdgeBackground,
    type PrintForm,
    renderLightMaster,
} from "./light.js";
import { buildEditInstruction } from "./method.js";
import { EDIT_REFERENCE_MAX_SIDE } from "./thresholds.js";
import { attemptPlan, redrawReason, startingTier } from "./tier.js";
import { evaluateVerification, type MasterVerifier } from "./verifier.js";

type Attempt = MasterOutput["master"]["attempts"][number];

const BUDGET_MESSAGE_MAX_LENGTH = 200;

/** 公开错误只附完整的文字差异说明，留足括号与省略号的位置。 */
function textSummary(failures: readonly MasterFailure[], maxLength: number) {
    let details = "";
    for (const { check, detail } of failures) {
        if (check !== "text") continue;
        const next = details ? `${details}、${detail}` : detail;
        if (next.length + 3 > maxLength)
            return details ? `（${details}…）` : "（文字差异说明已省略）";
        details = next;
    }
    return details ? `（${details}）` : "";
}

const hex = (rgb: readonly number[]) =>
    `#${rgb
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()}`;
const keyCandidates = [
    [255, 255, 255],
    [0, 255, 0],
    [255, 0, 255],
] as const;
/** 重档重绘没有原衬底：选一个与色板都相差较大的纯色，便于之后色键去底。 */
function chooseBackdrop(palette: ReturnType<typeof paletteOf>): string {
    const found = keyCandidates.find((rgb) =>
        palette.every(
            (p) => deltaE(srgbToLab(rgb[0], rgb[1], rgb[2]), p.lab) > 40,
        ),
    );
    return hex(found ?? keyCandidates[0]);
}

export function createTemplateMasterRegistration(options: {
    capability: TemplateMasterCapability;
    verifier: MasterVerifier;
    loadSource?: (url: string, signal: AbortSignal) => Promise<Buffer>;
    /** 已知费用累计；缺省读取本次运行的费用账本。 */
    spentUsd?: () => number;
}): ProcessRegistration {
    const spent =
        options.spentUsd ?? (() => currentCostLedger()?.snapshot().usd ?? 0);
    return defineProcessRegistration({
        id: "template-master",
        version: "v1",
        // 最坏：轻档 1 次校验 + 中、重各 3 次（改图 200s + 校验 90s + 加工）+ 读图与上传；
        // 上限 7 次尝试与 maxAttempts 无关，见 docs/api.md。
        timeoutMs: 2_400_000,
        inputSchema: masterInputSchema,
        outputSchema: masterOutputSchema,
        activities: [
            "master_source_loading",
            "master_light_rendering",
            "master_generation",
            "master_verification",
            "master_upload",
        ],
        execute: async (rawInput, context) => {
            if (isSourceRunMasterInput(rawInput)) {
                return failProcess(
                    "INVALID_INPUT",
                    "sourceRunId 必须在受理阶段由服务端解析后才能执行",
                );
            }
            const input = rawInput as ResolvedMasterInput;
            const spec = input.template.runtimeSemantics.designSpec;
            const form: PrintForm = spec.whole.printForm;
            const { marks } = input.condition;
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
                return failProcess(
                    "DEPENDENCY_FAILURE",
                    "参考图片无法读取或解码",
                );
            }
            const reference = await decodeRgba(source, EDIT_REFERENCE_MAX_SIDE);
            const sourceTransparent = hasTransparentPixel(reference);
            const size = templateImageSize(
                await decodeRgba(source, 4096),
            ) as (typeof masterEditSizes)[number];
            const palette = paletteOf(spec);
            const attempts: Attempt[] = [];
            let paidEdits = 0;
            let unknownCost = false;
            const unfinished = (
                code: "AGENT_FAILURE" | "DEPENDENCY_FAILURE",
                message: string,
            ) =>
                failProcess(
                    paidEdits > 0 ? "DEPENDENCY_FAILURE_AFTER_COMMIT" : code,
                    message,
                );
            const summary = (prefix: string, includeTextDetails = false) => {
                const counts = (["light", "medium", "heavy"] as const)
                    .map(
                        (t) =>
                            [
                                t,
                                attempts.filter((a) => a.tier === t).length,
                            ] as const,
                    )
                    .filter(([, n]) => n > 0)
                    .map(([t, n]) => `${t}×${n}`)
                    .join("、");
                const failures = attempts.at(-1)?.failures ?? [];
                const checks = [...new Set(failures.map((f) => f.check))];
                const message = `${prefix}已尝试 ${counts || "无"}${
                    checks.length ? `，最后失败项：${checks.join("、")}` : ""
                }`;
                const cost = unknownCost ? "；含费用未知的调用" : "";
                const details = includeTextDetails
                    ? textSummary(
                          failures,
                          BUDGET_MESSAGE_MAX_LENGTH -
                              message.length -
                              cost.length,
                      )
                    : "";
                return `${message}${details}${cost}`;
            };

            const initialTier = startingTier(input.condition);
            const reason =
                initialTier === "heavy" ? undefined : redrawReason(input);
            for (const tier of attemptPlan(reason ? "heavy" : initialTier)) {
                signal.throwIfAborted();
                if (
                    attempts.length >= input.budget.maxAttempts ||
                    spent() >= input.budget.maxUsd
                )
                    return failProcess(
                        "MASTER_BUDGET_EXHAUSTED",
                        summary(
                            `母版预算已用尽（次数上限 ${input.budget.maxAttempts}、金额上限 ${input.budget.maxUsd} USD）：`,
                            true,
                        ),
                    );
                // 轻档失败直接升档，中、重档带上一次失败原因重试。
                const last = attempts.at(-1);
                const retry =
                    last && last.tier === tier
                        ? last.failures.map((f) => f.detail)
                        : undefined;
                const failures: MasterFailure[] = [];
                let master: Buffer | undefined;
                try {
                    if (tier === "light") {
                        master = await context.runActivity(
                            "master_light_rendering",
                            () => renderLightMaster(source, form),
                        );
                    } else {
                        master = await context.runActivity(
                            "master_generation",
                            async () => {
                                const standalone = form === "standalone";
                                const backdrop = !standalone
                                    ? undefined
                                    : tier === "heavy"
                                      ? chooseBackdrop(palette)
                                      : hex(
                                            sourceTransparent
                                                ? [255, 255, 255]
                                                : edgeColor(reference).color,
                                        );
                                // 底：中档保持原衬底、重档用选定纯色；生成后统一由四边连通色键去底，
                                // 比模型直出透明稳定（无半透明光晕、可确定性复验）。
                                const flat = sourceTransparent
                                    ? await sharp(source)
                                          .rotate()
                                          .resize({
                                              width: EDIT_REFERENCE_MAX_SIDE,
                                              height: EDIT_REFERENCE_MAX_SIDE,
                                              fit: "inside",
                                              withoutEnlargement: true,
                                          })
                                          .flatten({
                                              background: backdrop ?? "#ffffff",
                                          })
                                          .png()
                                          .toBuffer()
                                    : await encodePng(reference);
                                paidEdits++;
                                let edited: Buffer;
                                try {
                                    edited = await options.capability.edit({
                                        image: flat,
                                        prompt: buildEditInstruction({
                                            tier,
                                            spec,
                                            form,
                                            marks,
                                            backdrop,
                                            retry,
                                        }),
                                        size,
                                        idempotencyKey: `${context.runId}-master-${attempts.length + 1}`,
                                        signal,
                                    });
                                } catch (error) {
                                    if (
                                        error instanceof MasterCapabilityError
                                    ) {
                                        if (error.reason === "unknown")
                                            unknownCost = true;
                                        failures.push({
                                            check: "generation",
                                            detail:
                                                error.reason === "rejected"
                                                    ? "图片服务明确拒绝了本次改图"
                                                    : "改图未返回可用结果，费用未知",
                                        });
                                        return undefined;
                                    }
                                    throw error;
                                }
                                const image = await decodeRgba(edited);
                                return encodePng(
                                    standalone && !hasTransparentPixel(image)
                                        ? keyOutEdgeBackground(image).image
                                        : image,
                                );
                            },
                        );
                    }
                } catch {
                    signal.throwIfAborted();
                    failures.push({
                        check: "generation",
                        detail: "成品无法解码或加工失败",
                    });
                }

                let verdict:
                    | ReturnType<typeof evaluateVerification>
                    | undefined;
                let similarity: Awaited<ReturnType<typeof checkSimilarity>> =
                    null;
                if (master && !failures.length) {
                    const printableResult = await checkPrintable(master, form);
                    const paletteResult = await checkPalette(master, spec);
                    similarity = await checkSimilarity(master, source, tier);
                    if (!printableResult.passed)
                        failures.push({
                            check: "printable",
                            detail: printableResult.detail ?? "不可印",
                        });
                    if (!paletteResult.passed)
                        failures.push({
                            check: "palette",
                            detail: paletteResult.detail ?? "配色不符",
                        });
                    if (similarity && !similarity.passed)
                        failures.push({
                            check: "similarity",
                            detail: `${similarity.detail ?? "相似度不足"}（${similarity.score}）`,
                        });
                    // 确定性项已不过时不再付模型校验费，本次尝试已判失败。
                    if (!failures.length) {
                        try {
                            const response = await context.runActivity(
                                "master_verification",
                                () =>
                                    options.verifier.verify({
                                        image: master as Buffer,
                                        ...(tier === "heavy" ? { source } : {}),
                                        transparent: form === "standalone",
                                        spec,
                                        marks,
                                        signal,
                                    }),
                                agentDiagnostic,
                            );
                            verdict = evaluateVerification(
                                spec,
                                marks,
                                response,
                                tier === "heavy",
                            );
                            failures.push(...verdict.failures);
                        } catch {
                            signal.throwIfAborted();
                            return unfinished(
                                "AGENT_FAILURE",
                                "母版对照校验未完成",
                            );
                        }
                    }
                }
                attempts.push({
                    tier,
                    passed: failures.length === 0,
                    failures,
                    ...(reason && attempts.length === 0 ? { reason } : {}),
                });
                if (failures.length || !master || !verdict) continue;

                let prepared: MasterOutput["preparedImage"];
                try {
                    prepared = await context.runActivity("master_upload", () =>
                        options.capability.upload(master as Buffer, signal),
                    );
                } catch {
                    signal.throwIfAborted();
                    return unfinished(
                        "DEPENDENCY_FAILURE",
                        "母版已通过校验但上传未完成",
                    );
                }
                return {
                    preparedImage: prepared,
                    master: {
                        tier,
                        redrawn: tier === "heavy",
                        attempts,
                        checks: {
                            text: verdict.text,
                            palette: { passed: true },
                            layout: verdict.layout,
                            printable: { passed: true },
                            similarity: similarity
                                ? { passed: true, score: similarity.score }
                                : null,
                        },
                    },
                } satisfies MasterOutput;
            }
            return failProcess(
                "MASTER_NOT_ACCEPTED",
                summary("全部档位用尽仍未得到通过校验的母版："),
            );
        },
    });
}
