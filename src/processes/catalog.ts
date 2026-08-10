import {
    createProcessRegistry,
    createProcessRunner,
    type ProcessExecutor,
    type ProcessRegistry,
} from "../process-runtime/index.js";
import type { ProcessRunRecords } from "../process-runtime/records.js";
import type { ContentAgent } from "./content/agent.js";
import type { ContentProcessingCapability } from "./content/capability.js";
import {
    type ContentProcessConfig,
    createContentRegistration,
} from "./content/registration.js";
import type { CrtAgent } from "./crt/agent.js";
import type { CrtRenderingCapability } from "./crt/capability.js";
import { createCrtRegistration } from "./crt/registration.js";
import type { PosterAgent } from "./poster/agent.js";
import type { PosterRenderingCapability } from "./poster/capability.js";
import { createPosterRegistration } from "./poster/registration.js";
import {
    createTitledContentRegistration,
    type TitledContentConfig,
} from "./titled-content/registration.js";

export type ProcessRuntimeOptions = {
    contentProcessing: ContentProcessingCapability;
    agent?: ContentAgent;
    processTimeoutMs?: number;
    runRecords?: ProcessRunRecords;
    processes?: {
        contentProcessing?: ContentProcessConfig;
        titledContentProcessing?: TitledContentConfig;
    };
    poster?: {
        agent: PosterAgent;
        capability: PosterRenderingCapability;
    };
    crt?: {
        agent: CrtAgent;
        capability: CrtRenderingCapability;
    };
};

export type ProcessRuntime = Readonly<{
    registry: ProcessRegistry;
    executor: ProcessExecutor;
}>;

export function createProcessExecutor(
    options: ProcessRuntimeOptions,
): ProcessExecutor {
    return createProcessRuntime(options).executor;
}

export function createProcessRuntime(
    options: ProcessRuntimeOptions,
): ProcessRuntime {
    const config = options.processes?.contentProcessing;
    const registrations = [
        createContentRegistration({
            capability: options.contentProcessing,
            agent: options.agent,
            mode: config?.mode,
            retryPolicy: config?.retryPolicy,
        }),
        createTitledContentRegistration({
            capability: options.contentProcessing,
            ...options.processes?.titledContentProcessing,
        }),
    ];
    if (options.poster) {
        registrations.push(createPosterRegistration(options.poster));
    }
    if (options.crt) {
        registrations.push(createCrtRegistration(options.crt));
    }
    const registry = createProcessRegistry(registrations);

    return Object.freeze({
        registry,
        executor: createProcessRunner({
            registry,
            processTimeoutMs: options.processTimeoutMs,
            runRecords: options.runRecords,
        }),
    });
}
