/** 窄 Content Agent Interface */
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
