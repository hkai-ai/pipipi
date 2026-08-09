import type { ContentOptimizationAgentRuntime } from "./agent-runtime.js";
import type { ContentProcessingCapability } from "./business-capabilities.js";
import {
  createContentProcessingRegistration,
  type ContentProcessingProcessConfig,
} from "./content-processing.js";
import type { ProcessRunRecords } from "./process-run-records.js";
import {
  createProcessRegistry,
  createProcessRunner,
  type ProcessExecutor,
  type ProcessRegistry,
} from "./process-runtime.js";
import {
  createTitledContentProcessingRegistration,
  type TitledContentProcessingConfig,
} from "./titled-content-processing.js";

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
