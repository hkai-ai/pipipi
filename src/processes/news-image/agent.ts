/** 窄 News Image Agent Port，生产实现见 agent.pi.ts */
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
