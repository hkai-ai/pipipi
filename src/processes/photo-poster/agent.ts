/** 照片风格提示词编译能力的 Agent 接口。 */
export type PhotoPosterAgent = Readonly<{
    compile: (request: {
        signal: AbortSignal;
        design?: string;
    }) => Promise<unknown>;
}>;
