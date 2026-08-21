/** 窄 News Image Agent Interface */
export type NewsImageAgentRequest = Readonly<{
    title: string;
    summary: string;
    signal: AbortSignal;
}>;

export type NewsImageCompilation = Readonly<{
    output: unknown;
    promptModel: string;
}>;

export type NewsImageAgent = Readonly<{
    compile: (request: NewsImageAgentRequest) => Promise<NewsImageCompilation>;
}>;
