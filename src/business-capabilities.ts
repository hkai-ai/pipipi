export type ContentProcessingCapability = {
  process: (
    input: { content: string },
    options: { signal: AbortSignal },
  ) => Promise<{ content: string }>;
};
