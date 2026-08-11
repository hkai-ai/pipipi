export type NewsImageAgentRequest = Readonly<{
    title: string;
    summary: string;
    signal: AbortSignal;
}>;

export type NewsImageAgent = Readonly<{
    compile: (request: NewsImageAgentRequest) => Promise<unknown>;
}>;
