export type ContentProcessingCapability = {
  process: (
    input: { content: string },
    options: { signal: AbortSignal },
  ) => Promise<{ content: string }>;
};

export class ContentProcessingUnavailable extends Error {
  constructor(options?: ErrorOptions) {
    super("Content processing is unavailable", options);
    this.name = "ContentProcessingUnavailable";
  }
}
