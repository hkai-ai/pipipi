import type { ContentAgent } from "./content/agent.js";
import type { ContentProcessingCapability } from "./content/capability.js";
import {
    type ContentProcessConfig,
    createContentRegistration,
} from "./content/registration.js";
import {
    createProcessRegistry,
    createProcessRunner,
    type ProcessExecutor,
    type ProcessRegistry,
} from "./runtime/index.js";
import type { ProcessRunRecords } from "./runtime/records.js";
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
    const registry = createProcessRegistry([
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
    ]);

    return Object.freeze({
        registry,
        executor: createProcessRunner({
            registry,
            processTimeoutMs: options.processTimeoutMs,
            runRecords: options.runRecords,
        }),
    });
}
