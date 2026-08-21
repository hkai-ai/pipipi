/** 无 Tool 的 Poster Agent Interface */
export type PosterAgentRequest = Readonly<{
    brief: string;
    text?: string;
    signal: AbortSignal;
}>;

export type PosterAgent = Readonly<{
    compile: (request: PosterAgentRequest) => Promise<unknown>;
}>;
