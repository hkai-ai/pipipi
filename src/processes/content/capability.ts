/** Content Processing Capability、内容处理契约 */
export type ContentProcessingCapability = {
    process: (
        input: { content: string },
        options: { signal: AbortSignal; idempotencyKey: string },
    ) => Promise<{ content: string }>;
};

export class ContentProcessingUnavailable extends Error {
    constructor(options?: ErrorOptions) {
        super("Content processing is unavailable", options);
        this.name = "ContentProcessingUnavailable";
    }
}
