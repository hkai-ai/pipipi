/** 看不到参考图和资产标识的无 Tool CRT Agent Port，生产实现见 agent.pi.ts */
import type { CrtAspectRatio, CrtPalette } from "./style.js";

export type CrtAgentRequest = Readonly<{
    palette: CrtPalette;
    aspectRatio: CrtAspectRatio;
    signal: AbortSignal;
}>;

export type CrtAgent = Readonly<{
    compile: (request: CrtAgentRequest) => Promise<unknown>;
}>;
