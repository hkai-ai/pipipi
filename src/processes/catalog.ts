import type { ContentOptimizationAgentRuntime } from "./content/agent.js";
import type { ContentProcessingCapability } from "./content/capability.js";
import {
    type ContentProcessingProcessConfig,
    createContentProcessingRegistration,
} from "./content/registration.js";
import {
    createProcessRegistry,
    createProcessRunner,
    type ProcessExecutor,
    type ProcessRegistry,
} from "./runtime/index.js";
import type { ProcessRunRecords } from "./runtime/records.js";
import {
    createTitledContentProcessingRegistration,
    type TitledContentProcessingConfig,
} from "./titled-content/registration.js";

export type BusinessProcessExecutorOptions = {
    contentProcessing: ContentProcessingCapability;
    agentRuntime?: ContentOptimizationAgentRuntime;
    processTimeoutMs?: number;
    runRecords?: ProcessRunRecords;
    processes?: {
        contentProcessing?: ContentProcessingProcessConfig;
        titledContentProcessing?: TitledContentProcessingConfig;
    };
};

export type BusinessProcessRuntime = Readonly<{
    registry: ProcessRegistry;
    executor: ProcessExecutor;
}>;

export function createBusinessProcessExecutor(
    options: BusinessProcessExecutorOptions,
): ProcessExecutor {
    return createBusinessProcessRuntime(options).executor;
}

export function createBusinessProcessRuntime(
    options: BusinessProcessExecutorOptions,
): BusinessProcessRuntime {
    const contentProcessingConfig = options.processes?.contentProcessing;
    const registry = createProcessRegistry([
        createContentProcessingRegistration({
            contentProcessing: options.contentProcessing,
            agentRuntime: options.agentRuntime,
            mode: contentProcessingConfig?.mode,
            retryPolicy: contentProcessingConfig?.retryPolicy,
        }),
        createTitledContentProcessingRegistration({
            contentProcessing: options.contentProcessing,
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
