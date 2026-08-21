/** 窄 Content Agent Port，生产实现见 agent.pi.ts */
import type { ContentProcessingCapability } from "./capability.js";

export type ContentAgentRequest = {
    content: string;
    signal: AbortSignal;
    idempotencyKey: string;
    capability: ContentProcessingCapability;
};

export type ContentAgent = {
    optimize: (request: ContentAgentRequest) => Promise<unknown>;
};
