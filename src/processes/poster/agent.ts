/** 无 Tool 的 Poster Agent Port，生产实现见 agent.pi.ts */
export type PosterAgentRequest = Readonly<{
    brief: string;
    text?: string;
    signal: AbortSignal;
}>;

export type PosterAgent = Readonly<{
    compile: (request: PosterAgentRequest) => Promise<unknown>;
}>;
