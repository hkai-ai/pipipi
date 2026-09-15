/** 调用内部换图生产服务，只恢复同一产物，禁止失联后自动重复付费。 */
import {
    finalizedTemplateImageSchema,
    type ImageApproval,
    type StrategyApproval,
    type TemplateImagePreparation,
    TemplateImagePreparationError,
} from "./capability.js";
export class HttpTemplateImagePreparation implements TemplateImagePreparation {
    constructor(private readonly baseUrl: string) {}
    savePlan(input: unknown, signal: AbortSignal) {
        return this.call("plans", input, signal, 60000);
    }
    render(input: StrategyApproval, signal: AbortSignal) {
        return this.call("render", input, signal, 240000);
    }
    async finalize(input: ImageApproval, signal: AbortSignal) {
        return finalizedTemplateImageSchema.parse(
            await this.call("finalize", input, signal, 60000),
        );
    }
    private async call(
        path: string,
        input: unknown,
        signal: AbortSignal,
        timeoutMs: number,
    ) {
        try {
            const response = await fetch(
                new URL(`/template-productions/${path}`, this.baseUrl),
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(input),
                    signal: AbortSignal.any([
                        signal,
                        AbortSignal.timeout(timeoutMs),
                    ]),
                },
            );
            if (!response.ok)
                throw new TemplateImagePreparationError(path !== "plans");
            return await response.json();
        } catch (error) {
            if (error instanceof TemplateImagePreparationError) throw error;
            throw new TemplateImagePreparationError(path !== "plans");
        }
    }
}
