import type { CrtAspectRatio, CrtPalette } from "./style.js";

export type CrtAgentRequest = Readonly<{
    palette: CrtPalette;
    aspectRatio: CrtAspectRatio;
    signal: AbortSignal;
}>;

export type CrtAgent = Readonly<{
    compile: (request: CrtAgentRequest) => Promise<unknown>;
}>;
