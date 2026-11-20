/** 母版的模型对照校验：一次多模态调用读字、核版面与水印，并由代码按设计默认值逐字比较。 */
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
import type { DesignSpec } from "../template-from-image/design-spec/vendor/design-spec-schema.js";
import type { MasterFailure } from "./contract.js";
import {
    buildVerificationPrompt,
    layoutBoxes,
    type MarkInput,
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
export type Verification = z.infer<typeof verificationSchema>;

export type MasterVerificationRequest = Readonly<{
    image: Buffer;
    transparent: boolean;
    spec: DesignSpec;
    marks: readonly MarkInput[];
    signal: AbortSignal;
}>;
export interface MasterVerifier {
    verify(request: MasterVerificationRequest): Promise<Verification>;
}

/** 归一化只做空白与大小写，其余字符（标点、全半角）逐字比较。 */
export const normalizeText = (text: string) =>
    text.replace(/\s+/gu, "").toLowerCase();

/**
 * 把模型读到的内容与 designSpec 默认值比较。失败说明只含元素 id 与数量，
 * 不回显读到的文字；水印残留计入 text 项（残留的标记文字同样是清单外文字）。
 */
export function evaluateVerification(
    spec: DesignSpec,
    marks: readonly MarkInput[],
    response: Verification,
) {
    const expected = textElements(spec);
    const reads = expected.map(
        (element) =>
            response.texts.find((item) => item.id === element.id)?.read ?? "",
    );
    const mismatched = expected
        .filter(
            (element, index) =>
                normalizeText(element.text) !==
                normalizeText(reads[index] as string),
        )
        .map((element) => element.id);
    const others = response.otherTexts.filter((text) => text.trim());
    const markRemains = marks.length > 0 && response.watermarkRemaining;
    const failures: MasterFailure[] = [];
    if (mismatched.length)
        failures.push({
            check: "text",
            detail: `文字与默认文字不一致的元素：${mismatched.join("、")}`.slice(
                0,
                200,
            ),
        });
    if (others.length)
        failures.push({
            check: "text",
            detail: `出现默认文字清单之外的文字 ${others.length} 处`,
        });
    if (markRemains)
        failures.push({ check: "text", detail: "原图水印、署名或标识仍可见" });
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
    return {
        text: {
            passed: !mismatched.length && !others.length && !markRemains,
            expected: expected.map((element) => element.text),
            read: [...reads, ...others],
        },
        layout: { passed: layoutPassed },
        failures,
    };
}

async function encodeView(bytes: Buffer, background?: string) {
    for (let side = 1280; side >= 100; side = Math.floor(side * 0.75)) {
        const view = sharp(bytes).resize({
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
            ...(options.provider === "openai"
                ? {
                      jsonSchema: {
                          name: "master_verification",
                          schema: verificationJsonSchema,
                      },
                  }
                : { jsonMode: true }),
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
        // 响应不是合法 JSON 或不符合形状时，对同一张图再问一次；核对是只读且便宜的。
        for (let attempt = 0; ; attempt++) {
            try {
                const { output } = await new PiStructuredAgent({
                    ...this.#options,
                    instructions: this.#options.jsonSchema
                        ? [VERIFIER_RULES]
                        : [
                              VERIFIER_RULES,
                              `输出须符合 JSON Schema：${JSON.stringify(verificationJsonSchema)}`,
                          ],
                }).run({
                    prompt: buildVerificationPrompt(
                        request.spec,
                        request.marks,
                    ),
                    images,
                    signal: request.signal,
                });
                return verificationSchema.parse(output);
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
