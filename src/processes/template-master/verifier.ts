/** 一次多模态调用核对母版文字、版面、水印及重档原图保真，并由代码逐字比较。 */
import {
    createAgentSession,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import { z } from "zod";
import { AgentJsonSyntaxError } from "../../agent-runtime/pi.js";
import {
    PiStructuredAgent,
    type PiStructuredAgentOptions,
} from "../../agent-runtime/structured.js";
import { normalizePrintText } from "../print-text.js";
import type { DesignSpec } from "../template-from-image/design-spec/vendor/design-spec-schema.js";
import type { MasterFailure } from "./contract.js";
import {
    buildVerificationPrompt,
    layoutBoxes,
    type MarkInput,
    SOURCE_FIDELITY_RULE,
    textElements,
    VERIFIER_RULES,
} from "./method.js";
import { VERIFIER_VIEW_BYTES } from "./thresholds.js";

export const verificationSchema = z.strictObject({
    texts: z
        .array(
            z.strictObject({
                id: z.string().max(80),
                read: z.string().max(2000),
            }),
        )
        .max(40),
    otherTexts: z.array(z.string().max(300)).max(20),
    layout: z.strictObject({
        passed: z.boolean(),
        offenders: z.array(z.string().max(80)).max(40),
    }),
    watermarkRemaining: z.boolean(),
});
const verificationJsonSchema = z.toJSONSchema(verificationSchema);
const redrawVerificationSchema = verificationSchema.extend({
    sourceFidelity: z.boolean(),
});
const redrawVerificationJsonSchema = z.toJSONSchema(redrawVerificationSchema);
export type Verification = z.infer<typeof verificationSchema> & {
    sourceFidelity?: boolean;
};

export type MasterVerificationRequest = Readonly<{
    image: Buffer;
    source?: Buffer;
    transparent: boolean;
    spec: DesignSpec;
    marks: readonly MarkInput[];
    signal: AbortSignal;
}>;
export interface MasterVerifier {
    verify(request: MasterVerificationRequest): Promise<Verification>;
}

function isSubsequence(shorter: string[], longer: string[]): boolean {
    let index = 0;
    for (const character of longer) {
        if (character === shorter[index]) index++;
    }
    return index === shorter.length;
}

function textDifference(expected: string, read: string): string | undefined {
    if (read === expected) return undefined;
    if (!read) return "读取为空";
    if (expected.replace(/\p{P}/gu, "") === read.replace(/\p{P}/gu, ""))
        return "仅标点或空白差异";

    const expectedChars = Array.from(expected);
    const readChars = Array.from(read);
    if (
        readChars.length < expectedChars.length &&
        isSubsequence(readChars, expectedChars)
    )
        return "缺字";
    if (
        readChars.length > expectedChars.length &&
        isSubsequence(expectedChars, readChars)
    )
        return "多字";
    if (expectedChars.sort().join("") === readChars.sort().join(""))
        return "文字顺序不同";
    return "文字内容不同";
}

/**
 * 把模型读到的内容与 designSpec 默认值比较。失败说明只含元素 id、差异类别与数量，
 * 不回显读到的文字；水印残留计入 text 项（残留的标记文字同样是清单外文字）。
 */
export function evaluateVerification(
    spec: DesignSpec,
    marks: readonly MarkInput[],
    response: Verification,
    requireSourceFidelity = false,
) {
    const expected = textElements(spec);
    const reads: string[] = [];
    const failures: MasterFailure[] = [];
    for (const element of expected) {
        const read =
            response.texts.find((item) => item.id === element.id)?.read ?? "";
        reads.push(read);
        const difference = textDifference(
            normalizePrintText(element.text),
            normalizePrintText(read),
        );
        if (difference)
            failures.push({
                check: "text",
                detail: `${element.id}：${difference}`,
            });
    }
    const others = response.otherTexts.filter((text) => text.trim());
    const markRemains = marks.length > 0 && response.watermarkRemaining;
    if (others.length)
        failures.push({
            check: "text",
            detail: `出现清单外文字 ${others.length} 处`,
        });
    if (markRemains)
        failures.push({ check: "text", detail: "原图水印、署名或标识仍可见" });
    const textPassed = failures.length === 0;
    const known = new Set(layoutBoxes(spec).map((box) => box.id));
    const offenders = response.layout.offenders.filter((id) => known.has(id));
    const layoutPassed =
        known.size === 0 ||
        (response.layout.passed && response.layout.offenders.length === 0);
    if (!layoutPassed)
        failures.push({
            check: "layout",
            detail: offenders.length
                ? `主要元素偏出版面框：${offenders.join("、")}`.slice(0, 200)
                : "主要元素未落在版面框内",
        });
    if (requireSourceFidelity && response.sourceFidelity !== true)
        failures.push({
            check: "similarity",
            detail: "重档母版未通过原图设计保真校验",
        });
    return {
        text: {
            passed: textPassed,
            expected: expected.map((element) => element.text),
            read: [...reads, ...others],
        },
        layout: { passed: layoutPassed },
        failures,
    };
}

async function encodeView(bytes: Buffer, background?: string) {
    for (let side = 1280; side >= 100; side = Math.floor(side * 0.75)) {
        const view = sharp(bytes).autoOrient().resize({
            width: side,
            height: side,
            fit: "inside",
            withoutEnlargement: true,
        });
        if (background) view.flatten({ background });
        const encoded = await view
            .webp({ quality: 82, alphaQuality: 90 })
            .toBuffer();
        if (encoded.length <= VERIFIER_VIEW_BYTES)
            return {
                data: encoded.toString("base64"),
                mimeType: "image/webp" as const,
            };
    }
    throw new Error("母版观察图编码超出预算");
}

export class PiMasterVerifier implements MasterVerifier {
    readonly #options: Omit<PiStructuredAgentOptions, "instructions">;
    constructor(options: Omit<PiStructuredAgentOptions, "instructions">) {
        this.#options = {
            ...options,
            thinkingLevel: "low",
            sessionFactory: async (sessionOptions) => {
                const result = await (
                    options.sessionFactory ?? createAgentSession
                )({
                    ...sessionOptions,
                    settingsManager: SettingsManager.inMemory({
                        cacheWarming: "off",
                        retry: { enabled: false, provider: { maxRetries: 0 } },
                        compaction: { enabled: false },
                    }),
                });
                const previous = result.session.agent.onPayload;
                result.session.agent.onPayload = async (payload, model) => {
                    const next = (await previous?.(payload, model)) ?? payload;
                    if (
                        !next ||
                        typeof next !== "object" ||
                        Array.isArray(next)
                    )
                        return next;
                    const {
                        max_tokens: _tokens,
                        max_completion_tokens: _completion,
                        max_output_tokens: _output,
                        ...rest
                    } = next as Record<string, unknown>;
                    return rest;
                };
                return result;
            },
        };
    }

    async verify(request: MasterVerificationRequest): Promise<Verification> {
        // 透明母版分别铺白与近黑，避免同色文字在单一底上看不见。
        const images = request.transparent
            ? [
                  await encodeView(request.image, "#ffffff"),
                  await encodeView(request.image, "#101010"),
              ]
            : [await encodeView(request.image)];
        if (request.source) images.push(await encodeView(request.source));
        const schema = request.source
            ? redrawVerificationJsonSchema
            : verificationJsonSchema;
        const instructions = [VERIFIER_RULES];
        if (request.source) instructions.push(SOURCE_FIDELITY_RULE);
        const openai = this.#options.provider === "openai";
        if (!openai)
            instructions.push(
                `输出须符合 JSON Schema：${JSON.stringify(schema)}`,
            );
        // 响应不是合法 JSON 或不符合形状时，对同一张图再问一次；核对是只读且便宜的。
        for (let attempt = 0; ; attempt++) {
            try {
                const { output } = await new PiStructuredAgent({
                    ...this.#options,
                    // 重档宿主规则补充固定 Skill 的三项校验，原图仅用于保真对照。
                    ...(request.source ? { skillFirst: true } : {}),
                    ...(openai
                        ? {
                              jsonSchema: {
                                  name: "master_verification",
                                  schema,
                              },
                          }
                        : { jsonMode: true }),
                    instructions,
                }).run({
                    prompt: buildVerificationPrompt(
                        request.spec,
                        request.marks,
                        request.source !== undefined,
                    ),
                    images,
                    signal: request.signal,
                });
                return request.source
                    ? redrawVerificationSchema.parse(output)
                    : verificationSchema.parse(output);
            } catch (error) {
                request.signal.throwIfAborted();
                const recoverable =
                    error instanceof AgentJsonSyntaxError ||
                    error instanceof z.ZodError;
                if (!recoverable || attempt >= 1) throw error;
            }
        }
    }
}
