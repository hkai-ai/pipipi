/** 商品做同款的 Pi 多模态规划与视觉质检实现：分别在规划和质检阶段使用无 Tool 的结构化会话。 */
import {
    createAgentSession,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { AgentJsonSyntaxError } from "../../agent-runtime/pi.js";
import {
    PiStructuredAgent,
    type PiStructuredAgentOptions,
} from "../../agent-runtime/structured.js";
import {
    type ProductRemixAgent,
    type ProductRemixPlanRequest,
    type ProductRemixVerifyRequest,
    type RemixPlan,
    type RemixVerification,
    remixPlanSchema,
    remixVerificationSchema,
} from "./agent.js";
import {
    buildPlanningPrompt,
    buildVerificationPrompt,
    PLANNER_RULES,
    VERIFIER_RULES,
} from "./method.js";

const VLM_CALL_TIMEOUT_MS = 90_000;

export class PiProductRemixAgent implements ProductRemixAgent {
    readonly #options: Omit<PiStructuredAgentOptions, "instructions">;

    constructor(options: Omit<PiStructuredAgentOptions, "instructions">) {
        this.#options = {
            ...options,
            thinkingLevel: "low",
            jsonMode: true,
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
                    ) {
                        return next;
                    }
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

    async plan(request: ProductRemixPlanRequest): Promise<RemixPlan> {
        const images = [request.sourceView, ...request.referenceViews];
        const prompt = buildPlanningPrompt({
            userText: request.userText,
            referenceCount: request.referenceViews.length,
            targetSize: request.targetSize,
        });
        return this.runWithSchemaRetry(
            () =>
                new PiStructuredAgent({
                    ...this.#options,
                    instructions: [PLANNER_RULES],
                }).run({
                    prompt,
                    images,
                    signal: AbortSignal.any([
                        request.signal,
                        AbortSignal.timeout(VLM_CALL_TIMEOUT_MS),
                    ]),
                }),
            remixPlanSchema,
            request,
        );
    }

    async verify(
        request: ProductRemixVerifyRequest,
    ): Promise<RemixVerification> {
        const images = [
            request.sourceView,
            ...request.referenceViews,
            request.candidateView,
        ];
        const prompt = buildVerificationPrompt({
            userText: request.userText,
            plan: request.plan,
            referenceCount: request.referenceViews.length,
        });
        return this.runWithSchemaRetry(
            () =>
                new PiStructuredAgent({
                    ...this.#options,
                    instructions: [VERIFIER_RULES],
                }).run({
                    prompt,
                    images,
                    signal: AbortSignal.any([
                        request.signal,
                        AbortSignal.timeout(VLM_CALL_TIMEOUT_MS),
                    ]),
                }),
            remixVerificationSchema,
            request,
        );
    }

    private async runWithSchemaRetry<T>(
        invoke: () => Promise<{ output: unknown }>,
        schema: z.ZodType<T>,
        request: Readonly<{ signal: AbortSignal; canRetry?: () => boolean }>,
    ): Promise<T> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                const { output } = await invoke();
                return schema.parse(output);
            } catch (error) {
                request.signal.throwIfAborted();
                const recoverable =
                    error instanceof AgentJsonSyntaxError ||
                    error instanceof z.ZodError;
                if (
                    !recoverable ||
                    attempt >= 1 ||
                    !(request.canRetry?.() ?? true)
                ) {
                    throw error;
                }
            }
        }
    }
}
