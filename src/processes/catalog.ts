/** 显式 production catalog 和通用 Process Runtime 组装 */
import {
    createProcessRegistry,
    createProcessRunner,
    type ProcessExecutor,
    type ProcessRegistration,
    type ProcessRegistry,
    type ProcessRunLogClock,
    type ProcessRunLogSink,
} from "../process-runtime/index.js";
import type { ProcessRunRecords } from "../process-runtime/records.js";
import { contentProduction } from "./content/production.js";
import { crtProduction } from "./crt/production.js";
import {
    narrativeMonumentProduction,
    paleWatercolorProduction,
    rawHumanismProduction,
} from "./news-image/production.js";
import { posterProduction } from "./poster/production.js";
import type { ProductionProcess } from "./production.js";
import { titledContentProduction } from "./titled-content/production.js";

/**
 * The explicit production catalog: one entry per exact `(id, version)`, each
 * owning how it is built from the startup environment. Nothing is discovered,
 * defaulted, or fallen back to; a Process ships only when it is listed here.
 */
export const productionCatalog: readonly ProductionProcess[] = Object.freeze([
    contentProduction,
    titledContentProduction,
    posterProduction,
    crtProduction,
    paleWatercolorProduction,
    rawHumanismProduction,
    narrativeMonumentProduction,
]);

export type ProcessRuntimeOptions = {
    registrations: readonly ProcessRegistration[];
    processTimeoutMs?: number;
    runRecords?: ProcessRunRecords;
    runLogSink?: ProcessRunLogSink;
    runLogClock?: ProcessRunLogClock;
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
    if (
        !Array.isArray(options.registrations) ||
        options.registrations.length === 0
    ) {
        throw new Error("At least one Process Registration is required");
    }
    const registry = createProcessRegistry(options.registrations);

    return Object.freeze({
        registry,
        executor: createProcessRunner({
            registry,
            processTimeoutMs: options.processTimeoutMs,
            runRecords: options.runRecords,
            runLogSink: options.runLogSink,
            runLogClock: options.runLogClock,
        }),
    });
}
